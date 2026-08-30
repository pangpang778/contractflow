// server/app.js — node:http 服务：/api/* CRUD + 迁移 + 角色校验；可选静态托管（T3 接线）。
// 统一错误信封 {ok,data,error}；身份 seam = Bearer 会话（ADR-0003），写操作埋点审计。

import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createContract, validateContract, applyUpdate, transition } from '../shared/contracts.js';
import { openChain, resolveStep, resolveContractStatus, currentStep } from '../shared/approvals.js';
import { computeDueReminders } from '../shared/reminders.js';
import { computeStats, computeUpcoming, computeOverdueChains } from '../shared/stats.js';
import { renderReport } from '../shared/report.js';
import { renderTemplate } from '../shared/mail.js';
import { buildVars, nextMailState, MAX_RETRY } from '../shared/consumer.js';
import { newId } from '../shared/ids.js';
import { createCounterparty, updateCounterparty, validateCounterparty, normalizeCounterparty, findDuplicate } from '../shared/counterparties.js';
import { buildSearchIndex, queryIndex } from '../shared/search.js';
import { createAmendment as createAmendmentEntity, transition as transitionAmendment, applyAmendment, validateAmendment } from '../shared/amendments.js';
import { withAudit, queryAudit, requestCtx } from './audit.js';
import { parseCsv } from '../shared/csv.js';
import { parseHeader as parseImportHeader, validateImportRow, makeImportedCounterparty, buildImportReport } from '../shared/importer.js';
import { deliverWebhook, nextWebhookState, validateWebhookConfig } from '../shared/webhooks.js';

// legal = 只读 + 仅 2 级链复核（read 档，不获建/改/提交权；审批动作按步骤角色精确判定）。
const ROLE_LEVEL = { viewer: 0, legal: 0, editor: 1, admin: 2 };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
};

// 相对方 DI：真 store（有 list/get/create/update/remove）或旧静态种子数组（测试便利）。
// 数组包装成内存 store，读路径统一 normalizeCounterparty 归一旧结构（缺信用代码/联系人、风险默认 C）。
const notSuperseded = (c) => c.superseded !== true; // S5：superseded 父合同在统计/提醒/导出读侧收敛

function toCounterpartyStore(src) {
  if (src && typeof src.list === 'function') return src;
  const arr = Array.isArray(src) ? src : [];
  return {
    async list() { return arr.map((r) => ({ ...r })); },
    async get(id) { const x = arr.find((r) => r.id === id); return x ? { ...x } : null; },
    async create(c) { arr.push(c); return c; },
    async update(id, fn) { const i = arr.findIndex((x) => x.id === id); if (i < 0) return null; const n = fn(arr[i]); arr[i] = n; return n; },
    async remove(id) { const i = arr.findIndex((x) => x.id === id); if (i < 0) return false; arr.splice(i, 1); return true; },
  };
}

// 变更单/相对方动作错误 → HTTP 映射。0 emitter 校验。
function mapDomainError(res, e) {
  const code = e.code;
  if (code === 'FORBIDDEN') return sendJson(res, 403, null, { code, message: e.message });
  if (code === 'ILLEGAL_TRANSITION' || code === 'INVALID_STATE') return sendJson(res, 409, null, { code, message: e.message });
  if (code === 'NOT_FOUND') return sendJson(res, 404, null, { code, message: e.message });
  return sendJson(res, 400, null, { code, message: e.message });
}

function sendJson(res, status, data, error) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(error ? { ok: false, error } : { ok: true, data }));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('body 非 JSON'), { code: 'BAD_BODY' })); }
    });
    req.on('error', reject);
  });
}

// 身份 helpers 移入 createApp 工厂，以闭包捕获 sessions（真实会话）。见工厂内实现。

// 审批事件（outbox，本功能只写，F3 消费）。
function outboxEvent(type, contract_id, chain_id, actor_id) {
  return { id: newId('evt'), type, contract_id, chain_id, actor_id, at: new Date().toISOString() };
}

// 合同最新的一条待决审批链；重提建新链，历史 rejected/approved 保留。
async function openChainFor(approvals, contractId) {
  if (!approvals) return null;
  const chains = await approvals.list();
  const pending = chains
    .filter((c) => c.contract_id === contractId && c.status === 'pending')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return pending[0] ?? null;
}

export function createApp({ store, counterparties = [], approvals = null, outbox = null, mails = null, amendments = null, staticDir = null, sessions = null, audit = null, rates = null, webhooks = null, webhookDeliveries = null, fetchImpl = null }) {
  let cpStore = toCounterpartyStore(counterparties); // 相对方：真 store 或旧数组种子 → 统一存储接口

  // —— 认证 seam（ADR-0003）：身份来源 = Bearer 会话，替换 ADR-0002 的 X-User-* 头。——
  // requireAuth 单函数：从 Authorization: Bearer <token> 解析会话 → {userId, role, expiresAt} 或 null。
  const auth = (req) => {
    if (!sessions) return null;
    const h = req.headers['authorization'];
    if (!h) return null;
    const m = /^Bearer\s+(.+)$/i.exec(String(h));
    return m ? sessions.validate(m[1].trim()) : null;
  };
  // 身份缺失/非法 → 401；角色不在 ROLE_LEVEL → 401（fail-closed，防配置错误角色越权）；角色级不足 → 403。失败已回包，返回 null。
  const requireLevel = (res, req, min) => {
    const a = auth(req);
    if (!a) {
      sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: '未认证或会话失效' });
      return null;
    }
    if (!(a.role in ROLE_LEVEL)) {
      sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: 'unknown role' });
      return null;
    }
    if (ROLE_LEVEL[a.role] < min) {
      sendJson(res, 403, null, { code: 'FORBIDDEN', message: 'insufficient role' });
      return null;
    }
    return { role: a.role };
  };
  // 审批动作身份：角色 + 用户 id（来自会话）。
  const ident = (req) => { const a = auth(req); return a ? { role: a.role, id: a.userId } : null; };

  // —— 审计埋点（seam S4）：写操作包在存储层（无 handler 侵入），actor 经 requestCtx 注入。——
  const withA = (s, entity) => (audit ? withAudit(s, { entity, audit }) : s);
  store = withA(store, 'contract');
  cpStore = withA(cpStore, 'counterparty');
  if (approvals) approvals = withA(approvals, 'approval');
  if (amendments) amendments = withA(amendments, 'amendment');

  // webhook 出站入队：对每个 enabled 配置落一条投递作业（持 webhooks + webhookDeliveries 才生效）。
  // 事件点调用处 await 并 try/catch —— 事件推送是旁路副作用，不因入队失败而失败主请求。
  async function enqueueWebhook(event) {
    if (!webhooks || !webhookDeliveries) return;
    for (const wh of await webhooks.list()) {
      if (!wh.enabled) continue;
      await webhookDeliveries.create({
        id: newId('wd'),
        event_type: event.type,
        event,
        webhook_id: wh.id,
        status: 'pending',
        attempts: 0,
        next_retry_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
      });
    }
  }
  const fireEnqueue = (event) =>
    enqueueWebhook(event).catch((e) => console.error('webhook enqueue failed', e));

  return createServer((req, res) => {
    // requestCtx 注入当前请求身份，供 withAudit 读取（未登录 → undefined → actor=system）。
    const actor = auth(req);
    return requestCtx.run(actor ? { id: actor.userId, role: actor.role } : undefined, async () => {
      try {
        const { pathname } = new URL(req.url, 'http://x');
        await route(req, res, pathname);
      } catch (e) {
        // 三个改接口共用：body 非 JSON → 400（而非 500）
        if (e.code === 'BAD_BODY') return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: e.message });
        if (!res.writableEnded) sendJson(res, 500, null, { code: 'INTERNAL', message: '服务端错误' });
      }
    });
  });

  async function route(req, res, pathname) {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    // —— 认证端点（seam S2）：登录签发 Bearer 会话，登出吊销。认证事件落审计（auth.*）。——
    const auditEvent = (rec) => { if (audit) audit.append({ ts: new Date().toISOString(), actor: 'system', ...rec }).catch((e) => console.error('audit write failed', e)); };
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (!sessions) return sendJson(res, 501, null, { code: 'NOT_CONFIGURED', message: '认证未接线' });
      const { username, password } = await readJsonBody(req);
      try {
        const s = await sessions.login(username, password);
        auditEvent({ actor: s.userId, action: 'auth.login', entity: 'auth', entity_id: s.userId });
        return sendJson(res, 200, { token: s.token, role: s.role, id: s.userId, expires_at: s.expiresAt });
      } catch (e) {
        if (e.code === 'LOCKED') {
          auditEvent({ action: 'auth.login_locked', entity: 'auth' });
          return sendJson(res, 423, null, { code: e.code, message: e.message, retry_after: Math.ceil(e.retryAfter / 1000) });
        }
        auditEvent({ action: 'auth.login_failed', entity: 'auth' }); // 用户名未验证，actor=unknown
        return sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: e.message });
      }
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const a = auth(req);
      if (!a) return sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: '未认证或会话失效' });
      await sessions.revoke(req.headers['authorization'].split(/\s+/)[1].trim());
      auditEvent({ actor: a.userId, action: 'auth.logout', entity: 'auth', entity_id: a.userId });
      res.writeHead(204);
      return res.end();
    }

    // —— 审计查询（seam S4）：admin 只读，可按 entity/actor/from/to 过滤（时序降序）。——
    if (pathname === '/api/audit' && req.method === 'GET') {
      if (!requireLevel(res, req, 2 /* admin */)) return;
      if (!audit) return sendJson(res, 501, null, { code: 'NOT_CONFIGURED', message: '审计未接线' });
      const sp = new URL(req.url, 'http://x').searchParams;
      const q = {};
      for (const k of ['entity', 'actor', 'from', 'to']) { const v = sp.get(k); if (v) q[k] = v; }
      return sendJson(res, 200, queryAudit(await audit.list(), q));
    }

    if (pathname === '/api/counterparties' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      const rows = await cpStore.list();
      return sendJson(res, 200, rows.map(normalizeCounterparty));
    }

    if (pathname === '/api/counterparties' && req.method === 'POST') {
      const a = requireLevel(res, req, 1 /* editor */);
      if (!a) return;
      const body = await readJsonBody(req);
      const v = validateCounterparty(body);
      if (!v.ok) return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: v.errors.join('; ') });
      const dup = findDuplicate(await cpStore.list(), body);
      if (dup) return sendJson(res, 409, null, { code: 'DUPLICATE', message: '该信用代码已被其他相对方占用', existing_id: dup.id });
      const cp = await cpStore.create(createCounterparty(body));
      return sendJson(res, 201, normalizeCounterparty(cp));
    }

    if (pathname === '/api/contracts' && req.method === 'POST') {
      const a = requireLevel(res, req, 1 /* editor */);
      if (!a) return;
      const input = await readJsonBody(req);
      const v = validateContract(input);
      if (!v.ok) return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: v.errors.join('; ') });
      if (input.counterparty_id !== undefined && !(await cpStore.get(input.counterparty_id))) {
        return sendJson(res, 400, null, { code: 'INVALID', message: 'relative counterparty not in library: 相对方不在库内' });
      }
      try {
        const contract = await store.create(createContract(input));
        await fireEnqueue({ type: 'contract.created', contract_id: contract.id, amount: contract.amount, currency: contract.currency, at: contract.created_at });
        return sendJson(res, 201, contract);
      } catch (e) {
        const { status, code } = mapStoreError(e);
        return sendJson(res, status, null, { code, message: e.message });
      }
    }

    if (pathname === '/api/contracts' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      // S5：默认收敛 superseded 父合同；?include_superseded=1 显式含父与继任（读侧过滤，不改纯函数）。
      const includeSuperseded = new URL(req.url, 'http://x').searchParams.get('include_superseded') === '1';
      const rows = await store.list();
      return sendJson(res, 200, includeSuperseded ? rows : rows.filter((c) => c.superseded !== true));
    }

    let m;
    if ((m = pathname.match(/^\/api\/contracts\/([^/]+)\/status$/)) && req.method === 'POST') {
      const id = m[1];
      const a = requireLevel(res, req, 0); // 迁移角色在领域层判定
      if (!a) return;
      const { to } = await readJsonBody(req);
      // 偏离④：已提交过审批链的合同，in_review→pending_sign 仅能经 approve 达成，raw /status 阻断。
      if (to === 'pending_sign' && approvals) {
        const chains = await approvals.list();
        if (chains.some((c) => c.contract_id === id)) {
          return sendJson(res, 409, null, { code: 'ILLEGAL_TRANSITION', message: '请通过审批链完成审批' });
        }
      }
      try {
        const updated = await store.update(id, (cur) => transition(cur, to, a.role));
        if (!updated) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
        return sendJson(res, 200, updated);
      } catch (e) {
        const code = e.code;
        if (code === 'FORBIDDEN') return sendJson(res, 403, null, { code, message: e.message });
        if (code === 'ILLEGAL_TRANSITION' || code === 'INVALID_STATE') return sendJson(res, 409, null, { code, message: e.message });
        return sendJson(res, 400, null, { code, message: e.message });
      }
    }

    // —— 审批工作流（seams S2+S3）：submit 建档、approve/reject 逐级留痕、outbox 只写 ——
    // 只读：当前合同最新一条审批链 + 待决步骤（供前端渲染，前端不复算规则）。
    if ((m = pathname.match(/^\/api\/contracts\/([^/]+)\/approval$/)) && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      const id = m[1];
      const chains = approvals ? await approvals.list() : [];
      const mine = chains.filter((c) => c.contract_id === id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const chain = mine[0] ?? null;
      const step = chain && chain.status === 'pending' ? currentStep(chain) : null;
      return sendJson(res, 200, { chain, current_step: step ? { level: step.level, role: step.role } : null });
    }

    if ((m = pathname.match(/^\/api\/contracts\/([^/]+)\/(submit|approve|reject)$/)) && req.method === 'POST') {
      const id = m[1];
      const action = m[2];
      const who = ident(req);
      if (!who) return sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: 'missing or invalid identity (role + id)' });
      if (action === 'submit' && ROLE_LEVEL[who.role] < 1) {
        return sendJson(res, 403, null, { code: 'FORBIDDEN', message: '仅 editor/admin 可提交审批' });
      }
      if (!approvals || !outbox) {
        return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '审批存储未接线' });
      }
      try {
        const contract = await store.get(id);
        if (!contract) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
        let chain;
        let next;
        if (action === 'submit') {
          if (contract.status !== 'draft') {
            return sendJson(res, 409, null, { code: 'ILLEGAL_TRANSITION', message: '只有 draft 可提交审批' });
          }
          chain = await approvals.create(openChain({ contractId: id, amount: contract.amount, submitterId: who.id }));
          next = await store.update(id, (cur) => resolveContractStatus(cur, 'in_review'));
          await outbox.create(outboxEvent('approval.requested', id, chain.id, who.id));
          await fireEnqueue({ type: 'approval.requested', contract_id: id, chain_id: chain.id, at: new Date().toISOString() });
          return sendJson(res, 200, { contract: next, chain });
        }
        const { comment } = await readJsonBody(req);
        chain = await openChainFor(approvals, id);
        if (!chain) {
          return sendJson(res, 409, null, { code: 'ILLEGAL_TRANSITION', message: '无待决审批链' });
        }
        const outcome = action === 'approve' ? 'approved' : 'rejected';
        const resolved = resolveStep(chain, who, outcome, comment);
        chain = await approvals.update(chain.id, () => resolved);
        next = contract;
        if (chain.status === 'approved') {
          next = await store.update(id, (cur) => resolveContractStatus(cur, 'pending_sign'));
        } else if (action === 'reject') {
          next = await store.update(id, (cur) => resolveContractStatus(cur, 'draft'));
        }
        await outbox.create(outboxEvent(`approval.${outcome}`, id, chain.id, who.id));
        await fireEnqueue({ type: `approval.${outcome}`, contract_id: id, chain_id: chain.id, at: new Date().toISOString() });
        return sendJson(res, 200, { contract: next, chain });
      } catch (e) {
        const code = e.code;
        if (code === 'FORBIDDEN') return sendJson(res, 403, null, { code, message: e.message });
        if (code === 'ILLEGAL_TRANSITION' || code === 'INVALID_STATE') return sendJson(res, 409, null, { code, message: e.message });
        if (code === 'INVALID') return sendJson(res, 400, null, { code, message: e.message });
        if (code === 'NOT_FOUND') return sendJson(res, 404, null, { code, message: e.message });
        return sendJson(res, 400, null, { code, message: e.message });
      }
    }

    if ((m = pathname.match(/^\/api\/contracts\/([^/]+)$/))) {
      const id = m[1];
      if (req.method === 'GET') {
        if (!requireLevel(res, req, 0)) return;
        const c = await store.get(id);
        return c ? sendJson(res, 200, c) : sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
      }
      if (req.method === 'PATCH') {
        const a = requireLevel(res, req, 1 /* editor */);
        if (!a) return;
        const patch = await readJsonBody(req);
        if (patch.counterparty_id !== undefined && !(await cpStore.get(patch.counterparty_id))) {
          return sendJson(res, 400, null, { code: 'INVALID', message: 'relative counterparty not in library: 相对方不在库内' });
        }
        try {
          const updated = await store.update(id, (cur) => applyUpdate(cur, patch));
          if (!updated) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
          return sendJson(res, 200, updated);
        } catch (e) {
          if (e.code === 'FROZEN') return sendJson(res, 409, null, { code: 'FROZEN', message: e.message });
          if (e.code === 'INVALID') return sendJson(res, 400, null, { code: 'INVALID', message: e.message });
          return sendJson(res, 400, null, { code: e.code, message: e.message });
        }
      }
      if (req.method === 'DELETE') {
        const a = requireLevel(res, req, 2 /* admin */);
        if (!a) return;
        const ok = await store.remove(id);
        if (!ok) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
        res.writeHead(204); // 204 不允许携带 body
        return res.end();
      }
    }

    // —— 到期提醒只读视图（无副作用）+ outbox 消费视图 + 外部触发消费（F3/frontier）——
    if (pathname === '/api/reminders/due' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      return sendJson(res, 200, computeDueReminders((await store.list()).filter(notSuperseded), new Date()));
    }

    if (pathname === '/api/outbox' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      const events = outbox ? await outbox.list() : [];
      const grouped = { pending: [], sent: [], failed: [] };
      for (const e of events) {
        const s = e.status ?? 'pending';
        (grouped[s] !== undefined ? grouped[s] : grouped.pending).push(e);
      }
      return sendJson(res, 200, grouped);
    }

    if (pathname === '/api/outbox/consume' && req.method === 'POST') {
      const a = requireLevel(res, req, 1); // editor/admin 触发；viewer/legal → 403
      if (!a) return;
      if (!outbox || !mails) {
        return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '通知存储未接线' });
      }
      const now = new Date();
      // 1) 扫到期提醒：已发送队列 id（= sent_key）为去重源，纯扫描结果交发送侧落盘
      const sentKeys = new Set((await mails.list()).map((m) => m.id));
      const due = computeDueReminders(await store.list(), now, sentKeys);
      let mailsWritten = 0;
      for (const r of due) {
        if (await mails.get(r.sent_key)) continue; // 去重，幂等
        const contract = await store.get(r.contract_id);
        const vars = buildVars({ type: 'reminder.due', payload: { due_date: r.due_date, days_left: r.days_left, tier: r.tier } }, contract);
        const mail = renderTemplate('reminder.due', vars);
        await mails.create({ id: r.sent_key, type: 'reminder.due', contract_id: r.contract_id, recipient_hint: '', subject: mail.subject, body: mail.body, sent_at: now.toISOString() });
        mailsWritten++;
      }
      // 2) 消费 outbox pending；failed 且未达退避上限则再试
      for (const evt of await outbox.list()) {
        const status = evt.status ?? 'pending';
        if (status === 'sent') continue;
        if (status === 'failed' && (evt.retry_count ?? 0) >= MAX_RETRY) continue;
        const contract = await store.get(evt.contract_id);
        let mail = null;
        let ok = true;
        let err = null;
        try { mail = renderTemplate(evt.type, buildVars(evt, contract)); } catch (e) { ok = false; err = e.message; }
        const next = nextMailState(evt, ok);
        if (ok && !(await mails.get(evt.id))) {
          await mails.create({ id: evt.id, type: evt.type, contract_id: evt.contract_id, recipient_hint: '', subject: mail.subject, body: mail.body, sent_at: now.toISOString() });
          mailsWritten++;
        }
        await outbox.update(evt.id, (cur) => ({
          ...cur, status: next.status, retry_count: next.retry_count,
          rendered: ok ? { subject: mail.subject, body: mail.body } : cur.rendered,
          error: ok ? undefined : err ?? cur.error,
        }));
      }
      const grouped = { pending: 0, sent: 0, failed: 0 };
      for (const e of await outbox.list()) { const s = e.status ?? 'pending'; if (grouped[s] !== undefined) grouped[s]++; }
      return sendJson(res, 200, { reminders_scanned: due.length, mails_written: mailsWritten, outbox: grouped });
    }

    // -- 统计看板 + 导出（seam S3）：两端点均只读（读-算-回包，不写任何存储）--
    if (pathname === '/api/stats' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return; // viewer 可读（偏离⑤）
      return sendJson(res, 200, computeStats((await store.list()).filter(notSuperseded), new Date(), { rates }));
    }

    if (pathname === '/api/export/report.md' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return; // viewer 可读（偏离⑤）
      const now = new Date();
      const contracts = (await store.list()).filter(notSuperseded);
      // approvals 未接线（如 smoke）时空链处理，overdue=[]，不 500。
      const chains = approvals ? await approvals.list() : [];
      const payload = {
        generated_at: now.toISOString(),
        // 与 /api/stats 同口径：外币折算 CNY（review MEDIUM：此前漏传 rates 致周报按原币累计，低于看板）。
        stats: computeStats(contracts, now, { rates }),
        upcoming: computeUpcoming(contracts, now),
        overdue: computeOverdueChains(chains, contracts, now),
      };
      const md = renderReport(payload);
      // 内联打开即导出（不做 attachment）；沿用 serveStatic 的 raw 回包模式。
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return res.end(md);
    }

    // —— 相对方 CRUD（seams S2+S3）：编辑 editor+、删除 admin+、去重/引用校验服务端判定 ——
    if ((m = pathname.match(/^\/api\/counterparties\/([^/]+)$/))) {
      const id = m[1];
      if (req.method === 'GET') {
        if (!requireLevel(res, req, 0)) return;
        const c = await cpStore.get(id);
        return c ? sendJson(res, 200, normalizeCounterparty(c)) : sendJson(res, 404, null, { code: 'NOT_FOUND', message: '相对方不存在' });
      }
      if (req.method === 'PATCH') {
        const a = requireLevel(res, req, 1 /* editor */);
        if (!a) return;
        const patch = await readJsonBody(req);
        const cur = await cpStore.get(id);
        if (!cur) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '相对方不存在' });
        const effCode = patch.credit_code !== undefined ? patch.credit_code : cur.credit_code;
        const dup = findDuplicate(await cpStore.list(), { credit_code: effCode }, id);
        if (dup) return sendJson(res, 409, null, { code: 'DUPLICATE', message: '该信用代码已被其他相对方占用', existing_id: dup.id });
        try {
          const updated = await cpStore.update(id, (c) => updateCounterparty(c, patch));
          if (!updated) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '相对方不存在' });
          return sendJson(res, 200, normalizeCounterparty(updated));
        } catch (e) {
          if (e.code === 'INVALID') return sendJson(res, 400, null, { code: 'INVALID', message: e.message });
          return mapDomainError(res, e);
        }
      }
      if (req.method === 'DELETE') {
        const a = requireLevel(res, req, 2 /* admin */);
        if (!a) return;
        const referenced = (await store.list()).some((c) => c.counterparty_id === id && c.superseded !== true);
        if (referenced) return sendJson(res, 409, null, { code: 'CONFLICT', message: '该相对方被合同引用，不可删除' });
        const ok = await cpStore.remove(id);
        if (!ok) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '相对方不存在' });
        res.writeHead(204); // 204 不允许携带 body
        return res.end();
      }
    }

    // —— 变更单 CRUD + 审批 + apply（seams S1+S3）：域纯函数在 shared/amendments.js，路由仅委托 ——
    if (amendments && pathname === '/api/amendments' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      return sendJson(res, 200, await amendments.list());
    }
    if (amendments && pathname === '/api/amendments' && req.method === 'POST') {
      const a = requireLevel(res, req, 1 /* editor */);
      if (!a) return;
      const body = await readJsonBody(req);
      const v = validateAmendment(body);
      if (!v.ok) return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: v.errors.join('; ') });
      const parent = await store.get(body.parent_contract_id);
      if (!parent) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '父合同不存在' });
      if (parent.superseded === true) return sendJson(res, 409, null, { code: 'ILLEGAL_TRANSITION', message: '父合同已失效，不可变更' });
      if (parent.status !== 'active') return sendJson(res, 409, null, { code: 'ILLEGAL_TRANSITION', message: '仅对已生效（active）父合同创建变更单' });
      const am = await amendments.create(createAmendmentEntity(body));
      return sendJson(res, 201, am);
    }
    if ((m = pathname.match(/^\/api\/amendments\/([^/]+)\/(submit|approve|reject|apply)$/)) && req.method === 'POST') {
      if (!amendments) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '变更单存储未接线' });
      const id = m[1];
      const action = m[2];
      const who = ident(req);
      if (!who) return sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: 'missing or invalid identity (role + id)' });
      if (action === 'submit' && ROLE_LEVEL[who.role] < 1) return sendJson(res, 403, null, { code: 'FORBIDDEN', message: '仅 editor/admin 可提交变更单' });
      if (action !== 'submit' && ROLE_LEVEL[who.role] < 2) return sendJson(res, 403, null, { code: 'FORBIDDEN', message: '仅 admin 可审批/应用变更单' });
      const am = await amendments.get(id);
      if (!am) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '变更单不存在' });
      if (action === 'apply') {
        const parent = await store.get(am.parent_contract_id);
        try {
          const out = applyAmendment(am, parent);
          await store.create(out.next);
          await store.update(parent.id, () => out.superseded);
          await amendments.update(id, () => out.amendment);
          await fireEnqueue({ type: 'amendment.applied', contract_id: out.next.id, parent_contract_id: parent.id, at: new Date().toISOString() });
          return sendJson(res, 200, out.next);
        } catch (e) {
          return mapDomainError(res, e);
        }
      }
      const { comment } = await readJsonBody(req);
      try {
        const target = { submit: 'in_review', approve: 'approved', reject: 'rejected' }[action];
        const next = transitionAmendment(am, target, who, { comment });
        await amendments.update(id, () => next);
        return sendJson(res, 200, next);
      } catch (e) {
        return mapDomainError(res, e);
      }
    }
    if ((m = pathname.match(/^\/api\/amendments\/([^/]+)$/)) && req.method === 'GET') {
      if (!amendments) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '变更单存储未接线' });
      if (!requireLevel(res, req, 0)) return;
      const am = await amendments.get(m[1]);
      if (!am) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '变更单不存在' });
      const parent = await store.get(am.parent_contract_id);
      const comparison = Object.keys(am.changes).map((f) => ({ field: f, from: parent ? parent[f] : null, to: am.changes[f] }));
      return sendJson(res, 200, { ...am, comparison });
    }

    // —— 全文搜索（seams S3+S4）：跨合同+相对方子串，viewer 可读、status 过滤叠加。读-建-查恒新鲜，不写存储 ——
    if (pathname === '/api/search' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return; // viewer 可读；未认证 401
      const sp = new URL(req.url, 'http://x').searchParams;
      const q = sp.get('q');
      if (q == null || String(q).trim() === '') {
        return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: '缺少查询参数 q' });
      }
      const status = sp.get('status') || undefined;
      const index = buildSearchIndex(await store.list(), (await cpStore.list()).map(normalizeCounterparty));
      return sendJson(res, 200, queryIndex(index, String(q), { status }));
    }

    // —— Webhook（Run D，seams S3+S2）：配置 CRUD admin 专属（secret 只写不读，GET 掩码）+ 试投 + 出站消费 ——
    // maskWebhook：响应层永不回 secret，只暴露 has_secret 布尔（防泄漏进日志/前端）。
    const maskWebhook = (w) => ({
      id: w.id, name: w.name, url: w.url, enabled: w.enabled,
      has_secret: Boolean(w.secret), created_at: w.created_at, updated_at: w.updated_at,
    });

    if (pathname === '/api/webhooks' && req.method === 'GET') {
      if (!requireLevel(res, req, 2)) return; // admin
      if (!webhooks) return sendJson(res, 501, null, { code: 'NOT_CONFIGURED', message: 'webhook 存储未接线' });
      return sendJson(res, 200, (await webhooks.list()).map(maskWebhook));
    }
    if (pathname === '/api/webhooks' && req.method === 'POST') {
      const a = requireLevel(res, req, 2);
      if (!a) return;
      if (!webhooks) return sendJson(res, 501, null, { code: 'NOT_CONFIGURED', message: 'webhook 存储未接线' });
      const body = await readJsonBody(req);
      const v = validateWebhookConfig(body);
      if (!v.ok) return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: v.errors.join('; ') });
      const now = new Date().toISOString();
      const wh = await webhooks.create({
        id: newId('wh'),
        name: body.name ?? body.url,
        url: String(body.url).trim(),
        secret: String(body.secret),
        enabled: body.enabled ?? true,
        created_at: now, updated_at: now,
      });
      return sendJson(res, 201, maskWebhook(wh));
    }
    if ((m = pathname.match(/^\/api\/webhooks\/([^/]+)\/test$/)) && req.method === 'POST') {
      const a = requireLevel(res, req, 2);
      if (!a) return;
      const wh = await webhooks.get(m[1]);
      if (!wh) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: 'webhook 不存在' });
      const out = await deliverWebhook({ url: wh.url, secret: wh.secret }, { type: 'webhook.test' }, { fetch: fetchImpl, now: Date.now() });
      return sendJson(res, 200, { sent: out.ok, status: out.status, error: out.error ?? null });
    }
    if ((m = pathname.match(/^\/api\/webhooks\/([^/]+)$/))) {
      const id = m[1];
      if (webhooks && req.method === 'PATCH') {
        const a = requireLevel(res, req, 2);
        if (!a) return;
        const wh = await webhooks.get(id);
        if (!wh) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: 'webhook 不存在' });
        const patch = await readJsonBody(req);
        const merged = {
          ...wh,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.url !== undefined ? { url: String(patch.url).trim() } : {}),
          ...(patch.secret !== undefined ? { secret: String(patch.secret) } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        };
        const v = validateWebhookConfig(merged);
        if (!v.ok) return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: v.errors.join('; ') });
        const updated = await webhooks.update(id, (cur) => ({ ...merged, updated_at: new Date().toISOString() }));
        return sendJson(res, 200, maskWebhook(updated));
      }
      if (webhooks && req.method === 'DELETE') {
        const a = requireLevel(res, req, 2);
        if (!a) return;
        const ok = await webhooks.remove(id);
        if (!ok) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: 'webhook 不存在' });
        res.writeHead(204);
        return res.end();
      }
    }
    if (pathname === '/api/webhooks/consume' && req.method === 'POST') {
      const a = requireLevel(res, req, 1); // editor+ 触发（镜像 outbox consume）
      if (!a) return;
      if (!webhookDeliveries) return sendJson(res, 501, null, { code: 'NOT_CONFIGURED', message: '投递存储未接线' });
      const now = Date.now();
      const whById = new Map((webhooks ? await webhooks.list() : []).map((w) => [w.id, w]));
      const counts = { sent: 0, failed: 0, dead: 0, processed: 0 };
      for (const job of await webhookDeliveries.list()) {
        const st = job.status ?? 'pending';
        if (st === 'sent' || st === 'dead') continue;
        if (st === 'failed' && (job.next_retry_at ?? 0) > now) continue; // 退避未到点
        const wh = whById.get(job.webhook_id);
        if (!wh || !wh.enabled) {
          await webhookDeliveries.update(job.id, (cur) => ({ ...cur, status: 'dead', last_error: 'webhook 未配置或已禁用' }));
          counts.dead++;
          counts.processed++;
          continue;
        }
        const out = await deliverWebhook({ url: wh.url, secret: wh.secret }, job.event, { fetch: fetchImpl, now });
        const next = nextWebhookState(job, out.ok, now);
        await webhookDeliveries.update(job.id, (cur) => ({
          ...cur,
          status: next.status,
          attempts: next.attempts,
          next_retry_at: next.next_retry_at ?? null,
          last_error: out.ok ? null : out.error,
        }));
        counts[next.status]++;
        counts.processed++;
      }
      const outbox = { pending: 0, sent: 0, failed: 0, dead: 0 };
      for (const j of await webhookDeliveries.list()) { const s = j.status ?? 'pending'; if (outbox[s] !== undefined) outbox[s]++; }
      return sendJson(res, 200, { processed: counts.processed, sent: counts.sent, failed: counts.failed, dead: counts.dead, outbox });
    }

    // —— CSV 批量导入（Run D，seams S6+S5+S4）：枚举固定表头，逐行校验，错误行进报告不中断整批 ——
    if (pathname === '/api/contracts/import' && req.method === 'POST') {
      const a = requireLevel(res, req, 1); // editor+（建合同+建相对方）
      if (!a) return;
      const text = await readRawBody(req);
      let parsed;
      try { parsed = parseCsv(text); } catch (e) {
        if (e.code === 'BAD_CSV') return sendJson(res, 400, null, { code: 'BAD_CSV', message: e.message });
        throw e;
      }
      const headerOk = parseImportHeader(parsed.header);
      if (!headerOk.ok) return sendJson(res, 400, null, { code: 'INVALID_HEADER', message: headerOk.reason });

      const existingIds = new Set((await store.list()).map((c) => c.id));
      const cpByName = new Map((await cpStore.list()).map((cp) => [cp.name, cp.id]));
      const seenIds = new Set(); // 批内已成功建合同的编号
      const results = [];
      const createdContractIds = [];
      const createdCounterpartyIds = [];
      const today = new Date().toISOString().slice(0, 10);

      for (const row of parsed.rows) {
        const lineno = results.length + 1;
        const v = validateImportRow(row, seenIds);
        if (v.skip) continue;
        if (!v.ok) { results.push({ line: lineno, field: '综合', reason: v.errors.join('; ') }); continue; }
        if (existingIds.has(v.contract.编号)) {
          results.push({ line: lineno, field: '编号', reason: `编号重复(库内): ${v.contract.编号}` });
          continue;
        }
        // 相对方按名匹配，不存在自动建（批内同名复用，不重复建）。
        let cpid = cpByName.get(v.contract.相对方名);
        if (!cpid) {
          const cp = makeImportedCounterparty(v.contract.相对方名);
          await cpStore.create(cp);
          cpByName.set(cp.name, cp.id);
          createdCounterpartyIds.push(cp.id);
          cpid = cp.id;
        }
        try {
          const c = await store.create(createContract(
            {
              title: v.contract.标题,
              counterparty_id: cpid,
              amount: v.contract.金额,
              currency: v.contract.币种,
              start_date: today,
              end_date: v.contract.到期日,
            },
            { id: v.contract.编号 },
          ));
          createdContractIds.push(c.id);
          seenIds.add(c.id);
          results.push(null);
        } catch (e) {
          if (e.code === 'CONFLICT' || e.code === 'INVALID') {
            results.push({ line: lineno, field: '编号', reason: e.message });
          } else throw e;
        }
      }
      const report = buildImportReport(results, { contractIds: createdContractIds, counterpartyIds: createdCounterpartyIds });
      return sendJson(res, 201, report);
    }

    sendJson(res, 404, null, { code: 'NOT_FOUND', message: `无此接口 ${req.method} ${pathname}` });
  }

  async function serveStatic(req, res, pathname) {
    if (!staticDir) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '无静态面' });
    if (req.method !== 'GET') return sendJson(res, 405, null, { code: 'METHOD_NOT_ALLOWED', message: '仅 GET' });
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const base = path.resolve(staticDir);
    const resolved = path.resolve(base, rel);
    // 必须在 base 之内：base 本身 或 base+sep 为前缀（否则同级前缀目录会被误放行）
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return sendJson(res, 403, null, { code: 'FORBIDDEN', message: '越界路径' });
    }
    try {
      const data = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '静态资源不存在' });
      throw e;
    }
  }
}