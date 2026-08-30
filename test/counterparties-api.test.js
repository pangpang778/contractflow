// test/counterparties-api.test.js — 相对方 CRUD + 去重 + 角色矩阵 + 删除引用（seams S2+S3，T2）。
// 临时端口真实 server：合同 + 相对方存储全接线。只测外部行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';

const EDITOR = { role: 'editor', id: 'u1' };
const ADMIN = { role: 'admin', id: 'u2' };
const VIEWER = { role: 'viewer', id: 'u3' };

// 18 位合法统一社会信用代码（合成：字母数字大写）；末 4 位数字区分唯一。
const code = (n) => '91370000MABCDE' + String(n).padStart(4, '0');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-cp-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const cpStore = await createFileStore(path.join(dir, 'counterparties.json'));
  const server = createApp({ store, counterparties: cpStore, staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
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

test('角色矩阵：viewer 读 200/创建 403；editor 创建 201、删除 403；admin 删除 204；缺身份 401', async (t) => {
  const { base } = await setup(t);
  assert.equal((await req(base, 'GET', '/api/counterparties', 'viewer', VIEWER.id)).status, 200);
  assert.equal((await req(base, 'POST', '/api/counterparties', 'viewer', VIEWER.id, { name: 'V', credit_code: code(1) })).status, 403);
  const created = await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '甲方', credit_code: code(2) });
  assert.equal(created.status, 201);
  assert.match(created.json.data.id, /^cp_/);
  assert.equal(created.json.data.risk_rating, 'C'); // 默认 C
  const id = created.json.data.id;
  assert.equal((await req(base, 'DELETE', `/api/counterparties/${id}`, 'viewer', VIEWER.id)).status, 403);
  assert.equal((await req(base, 'DELETE', `/api/counterparties/${id}`, 'editor', EDITOR.id)).status, 403);
  assert.equal((await req(base, 'DELETE', `/api/counterparties/${id}`, 'admin', ADMIN.id)).status, 204);
  assert.equal((await req(base, 'POST', '/api/counterparties', null, null, { name: 'X', credit_code: code(3) })).status, 401);
});

test('创建校验/去重：缺必填 400、risk 非法 400、撞码 409 携带既有 id、仅重名不同码 201、大小写同码 409', async (t) => {
  const { base } = await setup(t);
  assert.equal((await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { credit_code: code(10) })).status, 400);
  assert.equal((await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: 'N' })).status, 400);
  assert.equal((await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: 'N', credit_code: code(11), risk_rating: 'X' })).status, 400);
  const c1 = (await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '甲', credit_code: code(12) })).json.data;
  const dup = await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '乙', credit_code: code(12) });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'DUPLICATE');
  assert.equal(dup.json.error.existing_id, c1.id);
  assert.equal((await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '甲', credit_code: code(13) })).status, 201); // 重名不同码放行
  const lower = await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '丙', credit_code: code(12).toLowerCase() });
  assert.equal(lower.status, 409);
});

test('编辑：改字段保留；改成已存在信用代码 → 409；未知键 → 400', async (t) => {
  const { base } = await setup(t);
  const c1 = (await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '甲', credit_code: code(20), contact: '张三' })).json.data;
  const c2 = (await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '乙', credit_code: code(21) })).json.data;
  const up = await req(base, 'PATCH', `/api/counterparties/${c1.id}`, 'editor', EDITOR.id, { contact: '李四', risk_rating: 'A' });
  assert.equal(up.status, 200);
  assert.equal(up.json.data.contact, '李四');
  assert.equal(up.json.data.risk_rating, 'A');
  assert.equal(up.json.data.name, '甲'); // 未改字段保留
  const dupUp = await req(base, 'PATCH', `/api/counterparties/${c1.id}`, 'editor', EDITOR.id, { credit_code: code(21) });
  assert.equal(dupUp.status, 409);
  assert.equal((await req(base, 'PATCH', `/api/counterparties/${c1.id}`, 'editor', EDITOR.id, { nope: 1 })).status, 400);
  assert.equal(c2.id.length > 0, true);
});

test('删除：被非 superseded 合同引用 → 409；未引用 → 204', async (t) => {
  const { base } = await setup(t);
  const cp = (await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '供应商', credit_code: code(30) })).json.data;
  const contract = await req(base, 'POST', '/api/contracts', 'editor', EDITOR.id, {
    title: 'T', counterparty_id: cp.id, amount: 100, currency: 'CNY', start_date: '2026-01-01', end_date: '2026-12-31',
  });
  assert.equal(contract.status, 201);
  assert.equal((await req(base, 'DELETE', `/api/counterparties/${cp.id}`, 'admin', ADMIN.id)).status, 409);
  const free = (await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: 'X', credit_code: code(31) })).json.data;
  assert.equal((await req(base, 'DELETE', `/api/counterparties/${free.id}`, 'admin', ADMIN.id)).status, 204);
});

test('列表/详情返回完整形态：信用代码/联系人/风险默认；详情 404', async (t) => {
  const { base } = await setup(t);
  const c = (await req(base, 'POST', '/api/counterparties', 'editor', EDITOR.id, { name: '甲', credit_code: code(40) })).json.data;
  const list = await req(base, 'GET', '/api/counterparties', 'viewer', VIEWER.id);
  assert.equal(list.status, 200);
  const row = list.json.data.find((r) => r.id === c.id);
  assert.equal(row.credit_code, code(40));
  assert.equal(row.contact, null);
  assert.equal(row.risk_rating, 'C');
  const detail = await req(base, 'GET', `/api/counterparties/${c.id}`, 'viewer', VIEWER.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.name, '甲');
  assert.equal((await req(base, 'GET', '/api/counterparties/cp_nope', 'viewer', VIEWER.id)).status, 404);
});

test('旧静态种子数组经 DI 仍可读（回归：既有 http.test.js 靠数组注入）', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-cp-seed-'));
  const store = await createFileStore(path.join(dir, 'c.json'));
  const server = createApp({ store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const r = await req(base, 'GET', '/api/counterparties', 'viewer', VIEWER.id);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 1);
  assert.equal(r.json.data[0].id, 'cp_1');
  assert.equal(r.json.data[0].risk_rating, 'C'); // 旧行风险回填 C
});