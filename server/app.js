// server/app.js — node:http 服务：/api/* CRUD + 迁移 + 角色校验；可选静态托管（T3 接线）。
// 统一错误信封 {ok,data,error}；身份 seam = X-User-Role 头（mock，真认证后替换，ADR-0002）。

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
import { createAmendment as createAmendmentEntity, transition as transitionAmendment, applyAmendment, validateAmendment } from '../shared/amendments.js';

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

function roleOf(req) {
  const r = String(req.headers['x-user-role'] || '').toLowerCase();
  return r in ROLE_LEVEL ? r : null;
}

// 身份缺失/非法 → 401；角色级不足 → 403。失败已回包，返回 null。
function requireLevel(res, req, min) {
  const role = roleOf(req);
  if (!role) {
    sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: 'missing or invalid X-User-Role' });
    return null;
  }
  if (ROLE_LEVEL[role] < min) {
    sendJson(res, 403, null, { code: 'FORBIDDEN', message: 'insufficient role' });
    return null;
  }
  return { role };
}

// 审批动作身份：角色 + 用户 id（mock X-User-Id，ADR-0002 延续）。缺任一 → null。
function ident(req) {
  const role = roleOf(req);
  if (!role) return null;
  const id = String(req.headers['x-user-id'] || '').trim();
  return id ? { role, id } : null;
}

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

export function createApp({ store, counterparties = [], approvals = null, outbox = null, mails = null, amendments = null, staticDir = null }) {
  const cpStore = toCounterpartyStore(counterparties); // 相对方：真 store 或旧数组种子 → 统一存储接口
  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      await route(req, res, pathname);
    } catch (e) {
      // 三个改接口共用：body 非 JSON → 400（而非 500）
      if (e.code === 'BAD_BODY') return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: e.message });
      if (!res.writableEnded) sendJson(res, 500, null, { code: 'INTERNAL', message: '服务端错误' });
    }
  });

  async function route(req, res, pathname) {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

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
      return sendJson(res, 200, computeStats((await store.list()).filter(notSuperseded), new Date()));
    }

    if (pathname === '/api/export/report.md' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return; // viewer 可读（偏离⑤）
      const now = new Date();
      const contracts = (await store.list()).filter(notSuperseded);
      // approvals 未接线（如 smoke）时空链处理，overdue=[]，不 500。
      const chains = approvals ? await approvals.list() : [];
      const payload = {
        generated_at: now.toISOString(),
        stats: computeStats(contracts, now),
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