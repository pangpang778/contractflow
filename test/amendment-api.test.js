// test/amendment-api.test.js — 变更单 CRUD + 审批 + apply 端到端（seams S1+S3，T4）。
// 临时端口真实 server：合同 + 相对方 + 变更单存储全接线。只测外部行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { bootSessions, authClient } from './_session-helpers.js';

const VALID = {
  title: '采购合同', counterparty_id: 'cp_1', amount: 1500000, currency: 'CNY',
  start_date: '2026-09-01', end_date: '2027-09-01',
};
const EDITOR = { role: 'editor', id: '__unused' };
const ADMIN = { role: 'admin', id: '__unused' };
const VIEWER = { role: 'viewer', id: '__unused' };

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-amend-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const cpStore = await createFileStore(path.join(dir, 'counterparties.json'));
  await cpStore.create({ id: 'cp_1', name: '示例供应商' }); // S5 相对方库引用校验：被引用的 cp_1 必须在库内
  const amendments = await createFileStore(path.join(dir, 'amendments.json'));
  const sessions = await bootSessions(dir);
  const server = createApp({ store, counterparties: cpStore, amendments, sessions, staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, store, amendments };
}

const _clients = new Map();
async function req(base, method, p, role, id, body) {
  if (!_clients.has(base)) _clients.set(base, await authClient(base));
  return (await _clients.get(base)).reqJson(method, p, role, body); // id 已废弃（会话身份）
}
const createContract = (b, body = VALID) => req(b, 'POST', '/api/contracts', 'editor', EDITOR.id, body);
const toActive = async (b, id) => {
  for (const to of ['in_review', 'pending_sign', 'active']) {
    const r = await req(b, 'POST', `/api/contracts/${id}/status`, 'admin', ADMIN.id, { to });
    assert.equal(r.status, 200, `transition to ${to}`);
  }
};
const makeAmendment = (b, body) => req(b, 'POST', '/api/amendments', 'editor', EDITOR.id, body);
const amend = (b, id, action, who, body) => req(b, 'POST', `/api/amendments/${id}/${action}`, who.role, who.id, body);

test('角色矩阵：viewer 读 200/创建提交 403；editor 创建提交 200、审批/apply 403；缺身份 401', async (t) => {
  const { base } = await setup(t);
  assert.equal((await req(base, 'GET', '/api/amendments', 'viewer', VIEWER.id)).status, 200);
  const c = (await createContract(base)).json.data;
  await toActive(base, c.id);
  const body = { parent_contract_id: c.id, reason: '延期', changes: { end_date: '2028-09-01' } };
  assert.equal((await req(base, 'POST', '/api/amendments', 'viewer', VIEWER.id, body)).status, 403);
  const created = await makeAmendment(base, body);
  assert.equal(created.status, 201);
  assert.equal(created.json.data.status, 'draft');
  const amId = created.json.data.id;
  assert.equal((await amend(base, amId, 'submit', EDITOR)).status, 200);
  assert.equal((await amend(base, amId, 'approve', EDITOR, { comment: 'x' })).status, 403);
  assert.equal((await amend(base, amId, 'apply', EDITOR)).status, 403);
  assert.equal((await req(base, 'POST', `/api/amendments/${amId}/apply`, null, null)).status, 401);
});

test('创建校验：缺父/空 changes/金额浮点 → 400；父非 active/superseded → 409；父不存在 → 404；合法 → 201', async (t) => {
  const { base } = await setup(t);
  assert.equal((await makeAmendment(base, { reason: 'x', changes: { end_date: '2028-01-01' } })).status, 400);
  assert.equal((await makeAmendment(base, { parent_contract_id: 'c_x', reason: 'x', changes: {} })).status, 400);
  const c = (await createContract(base)).json.data;
  await toActive(base, c.id);
  assert.equal((await makeAmendment(base, { parent_contract_id: c.id, reason: 'x', changes: { amount: 2000000.5 } })).status, 400);
  const draft = (await createContract(base)).json.data; // 保持 draft
  assert.equal((await makeAmendment(base, { parent_contract_id: draft.id, reason: 'x', changes: { end_date: '2028-01-01' } })).status, 409);
  assert.equal((await makeAmendment(base, { parent_contract_id: 'c_nope', reason: 'x', changes: { end_date: '2028-01-01' } })).status, 404);
});

test('审批链：submit→in_review；意见必填 400；自审 403；approve→approved；reject→rejected；rejected 再提交 409', async (t) => {
  const { base } = await setup(t);
  const c = (await createContract(base)).json.data;
  await toActive(base, c.id);
  const am = (await makeAmendment(base, { parent_contract_id: c.id, reason: '改期', changes: { end_date: '2028-06-01' } })).json.data;
  const submit = await amend(base, am.id, 'submit', EDITOR);
  assert.equal(submit.status, 200);
  assert.equal(submit.json.data.status, 'in_review');
  assert.equal((await amend(base, am.id, 'approve', ADMIN, { comment: '  ' })).status, 400);
  const am2 = (await makeAmendment(base, { parent_contract_id: c.id, reason: 'r', changes: { end_date: '2028-07-01' } })).json.data;
  await amend(base, am2.id, 'submit', ADMIN); // admin 提交
  assert.equal((await amend(base, am2.id, 'approve', ADMIN, { comment: '自批' })).status, 403); // 自审拒绝
  const am3 = (await makeAmendment(base, { parent_contract_id: c.id, reason: 'r', changes: { end_date: '2028-08-01' } })).json.data;
  await amend(base, am3.id, 'submit', EDITOR);
  const appr = await amend(base, am3.id, 'approve', ADMIN, { comment: '同意' });
  assert.equal(appr.status, 200);
  assert.equal(appr.json.data.status, 'approved');
  const am4 = (await makeAmendment(base, { parent_contract_id: c.id, reason: 'r', changes: { end_date: '2028-09-01' } })).json.data;
  await amend(base, am4.id, 'submit', EDITOR);
  assert.equal((await amend(base, am4.id, 'reject', ADMIN, { comment: '' })).status, 400);
  const rej = await amend(base, am4.id, 'reject', ADMIN, { comment: '驳回' });
  assert.equal(rej.status, 200);
  assert.equal(rej.json.data.status, 'rejected');
  assert.equal((await amend(base, am4.id, 'submit', EDITOR)).status, 409);
});

test('apply 端到端：继任 version+1/active/继承，父 superseded+指针，变更单 applied 落 resulting_contract_id；重复 apply 409；非 approved 409', async (t) => {
  const { base } = await setup(t);
  const c = (await createContract(base)).json.data;
  await toActive(base, c.id);
  const am = (await makeAmendment(base, { parent_contract_id: c.id, reason: '调整', changes: { amount: 2000000, end_date: '2028-03-01' } })).json.data;
  const unapproved = (await makeAmendment(base, { parent_contract_id: c.id, reason: 'x', changes: { end_date: '2029-01-01' } })).json.data;
  assert.equal((await amend(base, unapproved.id, 'apply', ADMIN)).status, 409);
  await amend(base, am.id, 'submit', EDITOR);
  await amend(base, am.id, 'approve', ADMIN, { comment: 'ok' });
  const apply = await amend(base, am.id, 'apply', ADMIN);
  assert.equal(apply.status, 200);
  const next = apply.json.data;
  assert.equal(next.version, 2);
  assert.equal(next.status, 'active');
  assert.equal(next.parent_contract_id, c.id);
  assert.equal(next.amount, 2000000);
  assert.equal(next.end_date, '2028-03-01');
  assert.equal(next.title, c.title); // 未声明字段继承
  const parentAfter = await req(base, 'GET', `/api/contracts/${c.id}`, 'viewer', VIEWER.id);
  assert.equal(parentAfter.json.data.superseded, true);
  assert.equal(parentAfter.json.data.superseded_by, next.id);
  const detail = await req(base, 'GET', `/api/amendments/${am.id}`, 'viewer', VIEWER.id);
  assert.equal(detail.json.data.status, 'applied');
  assert.equal(detail.json.data.resulting_contract_id, next.id);
  assert.equal((await amend(base, am.id, 'apply', ADMIN)).status, 409); // 幂等终止
});

test('对照载荷：每个 changed 键含 field / from(父当前值) / to(changes)', async (t) => {
  const { base } = await setup(t);
  const c = (await createContract(base)).json.data;
  await toActive(base, c.id);
  const am = (await makeAmendment(base, { parent_contract_id: c.id, reason: '改价', changes: { amount: 2300000 } })).json.data;
  const d = await req(base, 'GET', `/api/amendments/${am.id}`, 'viewer', VIEWER.id);
  assert.equal(d.status, 200);
  assert.equal(d.json.data.comparison.length, 1);
  assert.equal(d.json.data.comparison[0].field, 'amount');
  assert.equal(d.json.data.comparison[0].from, c.amount);
  assert.equal(d.json.data.comparison[0].to, 2300000);
});

test('未接线变更单存储 → 读/写 404，不 500', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-amend-nowire-'));
  const store = await createFileStore(path.join(dir, 'c.json'));
  const sessions = await bootSessions(dir);
  const server = createApp({ store, sessions, staticDir: null }); // 缺 amendments
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  assert.equal((await req(base, 'GET', '/api/amendments', 'viewer', VIEWER.id)).status, 404);
  assert.equal((await makeAmendment(base, { parent_contract_id: 'c', reason: 'r', changes: { end_date: 'x' } })).status, 404);
});