// test/s5-superseded-filter.test.js — 票05 合同侧：superseded 收敛 + 相对方库引用校验（seam S5）。
// 临时端口真实 server：合同 + 相对方存储全接线。只测外部行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';

const EDITOR = { role: 'editor', id: 'u1' };
const nowISO = () => new Date().toISOString();
const dateFromToday = (d) => {
  const x = new Date();
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-s5-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const cpStore = await createFileStore(path.join(dir, 'counterparties.json'));
  await cpStore.create({ id: 'cp_1', name: '示例供应商', credit_code: '91370000MABCDE0001', risk_rating: 'C' });
  const server = createApp({ store, counterparties: cpStore, staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  return { base, store };
}

async function req(base, method, p, role, id, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers['X-User-Role'] = role;
  if (id) headers['X-User-Id'] = id;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* 204 等无 body */ }
  return { status: r.status, json };
}
const seed = (store, overrides = {}) => store.create({
  id: overrides.id ?? `c_${Math.random().toString(36).slice(2)}`,
  title: '合同', counterparty_id: 'cp_1', amount: 0, currency: 'CNY',
  start_date: '2026-01-01', end_date: dateFromToday(400), status: 'active',
  created_at: nowISO(), updated_at: nowISO(), superseded: false, ...overrides,
});
const mkContract = (b, body) => req(b, 'POST', '/api/contracts', 'editor', EDITOR.id, body);

test('US3-① 列表默认收敛 superseded；?include_superseded=1 含父与继任', async (t) => {
  const { base, store } = await setup(t);
  const v1 = await seed(store, { id: 'v1', superseded: true, superseded_by: 'v2' });
  await seed(store, { id: 'v2', parent_contract_id: v1.id, version: 2 });
  const hidden = await req(base, 'GET', '/api/contracts', 'viewer', 'u_v');
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.json.data.map((c) => c.id), ['v2'], '默认不含 superseded 父合同');

  const shown = await req(base, 'GET', '/api/contracts?include_superseded=1', 'viewer', 'u_v');
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.json.data.map((c) => c.id).sort(), ['v1', 'v2']);
  const par = shown.json.data.find((c) => c.id === 'v1');
  assert.equal(par.superseded, true);
  assert.equal(par.superseded_by, 'v2');
  assert.equal(shown.json.data.find((c) => c.id === 'v2').version, 2); // 版本链可读
});

test('US3-② 统计不双计：superseded 父合同金额不计入 total_cents', async (t) => {
  const { base, store } = await setup(t);
  const v1 = await seed(store, { id: 'v1', superseded: true, amount: 1_000_000 });
  await seed(store, { id: 'v2', parent_contract_id: v1.id, version: 2, amount: 2_000_000 });
  const r = await req(base, 'GET', '/api/stats', 'viewer', 'u_v');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.total_cents, 2_000_000, '只计继任，父合同不双计');
});

test('US3-③ 到期提醒不双计：superseded 父合同不产生提醒', async (t) => {
  const { base, store } = await setup(t);
  const v1 = await seed(store, { id: 'v1', superseded: true, end_date: dateFromToday(5) });
  await seed(store, { id: 'v2', parent_contract_id: v1.id, version: 2, end_date: dateFromToday(5) });
  const r = await req(base, 'GET', '/api/reminders/due', 'viewer', 'u_v');
  assert.equal(r.status, 200);
  const ids = r.json.data.map((x) => x.contract_id);
  assert.ok(!ids.includes('v1'), '父合同不产生提醒');
  assert.ok(ids.includes('v2'), '继任产生提醒');
});

test('US3-④ 表单消费相对方库：counterparty_id 不在库内 → 400；有效 → 201', async (t) => {
  const { base } = await setup(t);
  const VALID = { title: 'T', counterparty_id: 'cp_1', amount: 100, currency: 'CNY', start_date: '2026-01-01', end_date: '2026-12-31' };
  assert.equal((await mkContract(base, { ...VALID, counterparty_id: 'cp_nope' })).status, 400);
  assert.equal((await mkContract(base, { ...VALID, counterparty_id: 'cp_1' })).status, 201);
});

test('US3-⑤ 编辑承接同样校验：改成库外相对方 → 400；库内 → 200', async (t) => {
  const { base } = await setup(t);
  const c = (await mkContract(base, { title: 'T', counterparty_id: 'cp_1', amount: 100, currency: 'CNY', start_date: '2026-01-01', end_date: '2026-12-31' })).json.data;
  assert.equal((await req(base, 'PATCH', `/api/contracts/${c.id}`, 'editor', EDITOR.id, { counterparty_id: 'cp_nope' })).status, 400);
  assert.equal((await req(base, 'PATCH', `/api/contracts/${c.id}`, 'editor', EDITOR.id, { counterparty_id: 'cp_1' })).status, 200);
});