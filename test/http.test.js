import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';

const VALID = {
  title: '市集货架采购',
  counterparty_id: 'cp_1',
  amount: 1500000,
  currency: 'CNY',
  start_date: '2026-09-01',
  end_date: '2027-09-01',
};

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-api-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const server = createApp({ store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base };
}

async function req(base, method, p, role, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers['X-User-Role'] = role;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* 204 等无 body */ }
  return { status: r.status, json };
}

async function createAs(base, role, body = VALID) {
  return req(base, 'POST', '/api/contracts', role, body);
}
async function toStatus(base, role, id, to) {
  return req(base, 'POST', `/api/contracts/${id}/status`, role, { to });
}
async function makeAndState(base, role, state) {
  const c = (await createAs(base, 'editor')).json.data;
  let s = c;
  const steps = {
    in_review: ['in_review'],
    pending_sign: ['in_review', 'pending_sign'],
    active: ['in_review', 'pending_sign', 'active'],
    archived: ['in_review', 'pending_sign', 'active', 'archived'],
  }[state] || [];
  for (const to of steps) s = (await toStatus(base, role, s.id, to)).json.data;
  return s;
}

// —— 角色矩阵（S2 角色拒绝）——

test('viewer 只读：GET 可读，POST 403', async (t) => {
  const { base } = await setup(t);
  const list = await req(base, 'GET', '/api/contracts', 'viewer');
  assert.equal(list.status, 200);
  assert.equal(list.json.ok, true);
  assert.deepEqual(list.json.data, []);

  const created = await createAs(base, 'viewer');
  assert.equal(created.status, 403);
  assert.equal(created.json.ok, false);
});

test('身份头缺失 → 401，不落入业务分支', async (t) => {
  const { base } = await setup(t);
  const r = await req(base, 'POST', '/api/contracts', null, VALID);
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'UNAUTHORIZED');
});

test('editor 创建合法 → 201 draft；金额浮点/缺必填 → 400', async (t) => {
  const { base } = await setup(t);
  const ok = await createAs(base, 'editor');
  assert.equal(ok.status, 201);
  assert.match(ok.json.data.id, /^c_/);
  assert.equal(ok.json.data.status, 'draft');

  const float = await createAs(base, 'editor', { ...VALID, amount: 1500.5 });
  assert.equal(float.status, 400);
  assert.equal(float.json.error.code, 'BAD_REQUEST');

  const missing = await createAs(base, 'editor', { ...VALID, title: '' });
  assert.equal(missing.status, 400);
});

test('非法跳转 draft→active → 409，状态不变', async (t) => {
  const { base } = await setup(t);
  const c = (await createAs(base, 'editor')).json.data;
  const r = await toStatus(base, 'editor', c.id, 'active');
  assert.equal(r.status, 409);
  const after = await req(base, 'GET', `/api/contracts/${c.id}`, 'viewer');
  assert.equal(after.json.data.status, 'draft');
});

test('审批越权：editor 403，admin 200；作废/到期 admin-only', async (t) => {
  const { base } = await setup(t);
  const c = (await makeAndState(base, 'editor', 'in_review'));
  const deny = await toStatus(base, 'editor', c.id, 'pending_sign');
  assert.equal(deny.status, 403);
  const allow = await toStatus(base, 'admin', c.id, 'pending_sign');
  assert.equal(allow.status, 200);
  assert.equal(allow.json.data.status, 'pending_sign');

  const active = (await makeAndState(base, 'admin', 'active'));
  assert.equal((await toStatus(base, 'editor', active.id, 'void')).status, 403);
  assert.equal((await toStatus(base, 'admin', active.id, 'expired')).json.data.status, 'expired');
});

test('冻结：active 后改主体字段 409；回传 status 被忽略', async (t) => {
  const { base } = await setup(t);
  const active = (await makeAndState(base, 'admin', 'active'));
  const r = await req(base, 'PATCH', `/api/contracts/${active.id}`, 'editor', { amount: 2000000 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'FROZEN');

  const forged = await req(base, 'PATCH', `/api/contracts/${active.id}`, 'editor', { status: 'expired' });
  assert.equal(forged.status, 200);
  assert.equal(forged.json.data.status, 'active');
});

test('终态无出边：archived 后再迁 → 409', async (t) => {
  const { base } = await setup(t);
  const archived = (await makeAndState(base, 'admin', 'archived'));
  const r = await toStatus(base, 'admin', archived.id, 'active');
  assert.equal(r.status, 409);
});

test('删除 admin-only：viewer 403，admin 204，之后 GET 404', async (t) => {
  const { base } = await setup(t);
  const c = (await createAs(base, 'editor')).json.data;
  assert.equal((await req(base, 'DELETE', `/api/contracts/${c.id}`, 'viewer')).status, 403);
  const del = await req(base, 'DELETE', `/api/contracts/${c.id}`, 'admin');
  assert.equal(del.status, 204);
  assert.equal((await req(base, 'GET', `/api/contracts/${c.id}`, 'viewer')).status, 404);
});

test('未冻结编辑（editor）→ 200；不可变返回新对象', async (t) => {
  const { base } = await setup(t);
  const c = (await createAs(base, 'editor')).json.data;
  const r = await req(base, 'PATCH', `/api/contracts/${c.id}`, 'editor', { description: '补充' });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.description, '补充');
  assert.notEqual(r.json.data, c);
});

test('malformed JSON body → 400（非 500）', async (t) => {
  const { base } = await setup(t);
  const r = await fetch(`${base}/api/contracts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'editor' },
    body: '{bad json',
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'BAD_REQUEST');
});

test('相对方只读种子经 API 暴露', async (t) => {
  const { base } = await setup(t);
  const r = await req(base, 'GET', '/api/counterparties', 'viewer');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 1);
  assert.equal(r.json.data[0].id, 'cp_1');
});