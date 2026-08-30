// test/audit.test.js — T3 审计域：JSONL 只追加写入器 + 查询过滤纯函数 + 存储写路径埋点 + GET /api/audit。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { createSessionStore, hashPassword } from '../server/auth.js';
import { createAuditWriter, queryAudit, requestCtx, withAudit } from '../server/audit.js';

const COST = 1 << 10;
const PW = 'pw-' + Date.now() % 100000;
const SALT = 'deadbeef00000000';

// 1 —— JSONL 只追加：一条一条 valid JSONL；再次 append 不覆盖先前。
test('写入器：append 追加 valid JSONL 行，重复 append 不清前文', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-aud-'));
  try {
    const w = await createAuditWriter(path.join(dir, 'audit.log'));
    await w.append({ actor: 'a', action: 'contract.create', entity: 'contract', entity_id: 'c1' });
    await w.append({ actor: 'b', action: 'contract.update', entity: 'contract', entity_id: 'c2' });
    const rows = await w.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'contract.create');
    assert.equal(rows[1].action, 'contract.update');
    assert.ok(rows[0].ts, '默认打 ts');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// 2 —— 并发 append：单例锁保证全部落盘、无截断。
test('写入器：并发 append 不丢失、不截断', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-aud-'));
  try {
    const w = await createAuditWriter(path.join(dir, 'audit.log'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => w.append({ actor: 'u' + i, action: 'x', entity: 'e', entity_id: '' + i })));
    const rows = await w.list();
    assert.equal(rows.length, 20);
    assert.equal(new Set(rows.map((r) => r.actor)).size, 20, '20 条全在且互异');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// 3 —— queryAudit 纯函数：过滤与降序。
test('queryAudit：无参全量降序；entity/actor/时间过滤组合生效', () => {
  const recs = [
    { ts: '2026-08-30T00:00:00Z', entity: 'contract', actor: 'u1', action: 'create' },
    { ts: '2026-08-30T00:00:01Z', entity: 'contract', actor: 'u2', action: 'update' },
    { ts: '2026-08-30T00:00:02Z', entity: 'approval', actor: 'u1', action: 'create' },
  ];
  assert.deepEqual(queryAudit(recs).map((r) => r.action), ['create', 'update', 'create'], '全量、ts 降序');
  assert.equal(queryAudit(recs, { entity: 'approval' }).length, 1);
  assert.deepEqual(queryAudit(recs, { actor: 'u1' }).map((r) => r.entity), ['approval', 'contract'], '多实体按 actor 过滤');
  assert.equal(queryAudit(recs, { from: '2026-08-30T00:00:01Z' }).length, 2);
  assert.equal(queryAudit(recs, { to: '2026-08-30T00:00:00Z' }).length, 1);
  assert.equal(queryAudit(recs, { entity: 'contract', actor: 'u2' }).length, 1);
  // 入参不改动（不可变）
  assert.equal(recs.length, 3);
});

// 4 —— withAudit.create：actor 从 requestCtx 注入；无 ctx → system。
test('withAudit：create 带 actor（来自 AsyncLocalStorage），无 ctx 兜底 system', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-aud-'));
  try {
    const raw = await createFileStore(path.join(dir, 'c.json'));
    const audit = await createAuditWriter(path.join(dir, 'audit.log'));
    const wrapped = withAudit(raw, { entity: 'contract', audit });
    // 无 ctx
    await wrapped.create({ id: 'c1', title: 'A' });
    // 带 actor
    await requestCtx.run({ id: 'u_editor', role: 'editor' }, () => wrapped.create({ id: 'c2', title: 'B' }));
    const rows = await audit.list();
    const c1 = rows.find((r) => r.entity_id === 'c1');
    const c2 = rows.find((r) => r.entity_id === 'c2');
    assert.equal(c1.actor, 'system');
    assert.equal(c1.action, 'contract.create');
    assert.equal(c1.entity, 'contract');
    assert.deepEqual(c1.from, null);
    assert.equal(c2.actor, 'u_editor');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// 5 —— withAudit.update：from/to 最小差异 + status 变更 reason。
test('withAudit：update 记 from/to 差异与 status 演进 reason', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-aud-'));
  try {
    const raw = await createFileStore(path.join(dir, 'c.json'));
    const audit = await createAuditWriter(path.join(dir, 'audit.log'));
    const wrapped = withAudit(raw, { entity: 'contract', audit });
    await requestCtx.run({ id: 'u_admin' }, async () => {
      await wrapped.create({ id: 'c1', status: 'draft' });
      await wrapped.update('c1', (row) => ({ ...row, status: 'active', owner: 'x' }));
    });
    const rows = await audit.list();
    const upd = rows.find((r) => r.action === 'contract.update');
    assert.equal(upd.from.status, 'draft');
    assert.equal(upd.to.status, 'active');
    assert.ok(upd.from.owner === undefined, '未变化的 owner 不进 from');
    assert.equal(upd.to.owner, 'x');
    assert.equal(upd.reason, 'status draft→active');
    // 未命中不审计
    await requestCtx.run({ id: 'u_admin' }, () => wrapped.update('ghost', (r) => ({ ...r, status: 'active' })));
    assert.equal((await audit.list()).filter((r) => r.action === 'contract.update').length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// 集成 setup：真实服务 + sessions + audit。
async function server(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-aud-api-'));
  const users = [
    { id: 'u_admin', username: 'admin', role: 'admin', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
    { id: 'u_editor', username: 'editor', role: 'editor', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
    { id: 'u_viewer', username: 'viewer', role: 'viewer', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
  ];
  const usersFile = path.join(dir, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify(users));
  const sessions = await createSessionStore({ file: path.join(dir, 'sessions.json'), usersFile, cost: COST });
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const counterparties = await createFileStore(path.join(dir, 'cps.json'));
  await counterparties.create({ id: 'cp_1', name: '示例供应商', created_at: null });
  const audit = await createAuditWriter(path.join(dir, 'audit.log'));
  const server = createApp({ store, counterparties, sessions, audit });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  return { base };
}

async function login(base, username, password) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return r.json();
}
const bearer = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const VALID = { title: '审计合同', counterparty_id: 'cp_1', amount: 1000, currency: 'CNY', start_date: '2026-01-01', end_date: '2026-12-31' };

// 6 —— GET /api/audit 权限矩阵：admin 200、viewer 403、无 token 401。
test('GET /api/audit：admin 200、viewer 403、无/坏 token 401', async (t) => {
  const { base } = await server(t);
  const admin = bearer((await login(base, 'admin', PW)).data.token);
  const viewer = bearer((await login(base, 'viewer', PW)).data.token);
  const r = await fetch(base + '/api/audit', { headers: admin });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).data));
  assert.equal((await fetch(base + '/api/audit', { headers: viewer })).status, 403);
  assert.equal((await fetch(base + '/api/audit')).status, 401);
  assert.equal((await fetch(base + '/api/audit', { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

// 7 —— 写路径审计：登录事件 + 业务写 + 查询过滤实体/actor。
test('审计端到端：auth 事件 + contract.create 记 actor，/api/audit 可按 entity/actor 过滤', async (t) => {
  const { base } = await server(t);
  // 一次成功登录 + 一次失败登录（无此用户）→ 触发 auth.event
  const tok = (await login(base, 'editor', PW)).data.token;
  await login(base, 'ghost', 'nope');
  const eb = bearer(tok);
  // editor 建合同 → contract.create
  const created = await fetch(base + '/api/contracts', { method: 'POST', headers: eb, body: JSON.stringify(VALID) });
  assert.equal(created.status, 201);
  // admin 查询
  const admin = bearer((await login(base, 'admin', PW)).data.token);
  const all = (await (await fetch(base + '/api/audit', { headers: admin })).json()).data;
  assert.ok(all.some((r) => r.action === 'auth.login' && r.actor === 'u_editor'), '登录事件 actor=userId');
  assert.ok(all.some((r) => r.action === 'auth.login_failed'), '失败登录也入审计');
  const creates = all.filter((r) => r.entity === 'contract' && r.action === 'contract.create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].actor, 'u_editor', '业务写 actor=操作者 userId');
  // 按 actor 过滤
  const mine = (await (await fetch(base + '/api/audit?actor=u_editor', { headers: admin })).json()).data;
  assert.ok(mine.every((r) => r.actor === 'u_editor'));
  // 按 entity 过滤
  const cps = (await (await fetch(base + '/api/audit?entity=contract', { headers: admin })).json()).data;
  assert.ok(cps.every((r) => r.entity === 'contract'));
});

// 8 —— 写路径全覆盖：counterparty create/remove、contract status transition 均落审计（含 remove 分支）。
test('写路径审计：counterparty.create/remove + contract.update(status) 均记 actor 与 reason', async (t) => {
  const { base } = await server(t);
  const editor = bearer((await login(base, 'editor', PW)).data.token);
  const admin = bearer((await login(base, 'admin', PW)).data.token);
  // counterparty 建 + 删（不引用 → 可删）
  const cp = await fetch(base + '/api/counterparties', { method: 'POST', headers: editor, body: JSON.stringify({ name: '新供应商', credit_code: '91370000MABCDE0002' }) });
  const cpid = (await cp.json()).data.id;
  // 建合同 + 状态迁移
  const c = await fetch(base + '/api/contracts', { method: 'POST', headers: editor, body: JSON.stringify(VALID) });
  const cid = (await c.json()).data.id;
  const st = await fetch(base + `/api/contracts/${cid}/status`, { method: 'POST', headers: admin, body: JSON.stringify({ to: 'in_review' }) });
  assert.equal(st.status, 200);
  // 删 counterparty
  const del = await fetch(base + `/api/counterparties/${cpid}`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 204);
  // admin 捞审计核对
  const all = (await (await fetch(base + '/api/audit', { headers: admin })).json()).data;
  const cpCreate = all.find((r) => r.action === 'counterparty.create' && r.entity_id === cpid);
  assert.ok(cpCreate && cpCreate.actor === 'u_editor', 'counterparty.create 记 actor');
  const cpRemove = all.find((r) => r.action === 'counterparty.remove' && r.entity_id === cpid);
  assert.ok(cpRemove && cpRemove.actor === 'u_admin', 'counterparty.remove 记 actor');
  const statusUpd = all.find((r) => r.action === 'contract.update' && r.entity_id === cid);
  assert.ok(statusUpd, 'contract status 迁移记 contract.update');
  assert.equal(statusUpd.from.status, 'draft');
  assert.equal(statusUpd.to.status, 'in_review');
  assert.equal(statusUpd.reason, 'status draft→in_review');
});