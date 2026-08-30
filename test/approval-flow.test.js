// test/approval-flow.test.js — 审批 API 端到端 + outbox（seams S2+S3，T2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';

const VALID = {
  title: '大型采购项目',
  counterparty_id: 'cp_1',
  amount: 1500000,
  start_date: '2026-09-01',
  end_date: '2027-09-01',
};
const EDITOR = { role: 'editor', id: 'u_1' };
const EDITOR2 = { role: 'editor', id: 'u_4' };
const ADMIN = { role: 'admin', id: 'u_2' };
const LEGAL = { role: 'legal', id: 'u_3' };
const VIEWER = { role: 'viewer', id: 'u_6' };

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-ap-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const approvals = await createFileStore(path.join(dir, 'approvals.json'));
  const outbox = await createFileStore(path.join(dir, 'outbox.json'));
  const server = createApp({
    store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], approvals, outbox, staticDir: null,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, approvals, outbox };
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
const create = (b, role, id, body = VALID) => req(b, 'POST', '/api/contracts', role, id, body);
const submit = (b, role, id, cid) => req(b, 'POST', `/api/contracts/${cid}/submit`, role, id);
const approve = (b, role, id, cid, comment) => req(b, 'POST', `/api/contracts/${cid}/approve`, role, id, { comment });
const reject = (b, role, id, cid, comment) => req(b, 'POST', `/api/contracts/${cid}/reject`, role, id, { comment });

async function newSubmittedContract(base, amount = VALID.amount, by = EDITOR) {
  const c = (await create(base, by.role, by.id, { ...VALID, amount })).json.data;
  const s = await submit(base, by.role, by.id, c.id);
  assert.equal(s.status, 200);
  return { contract: c, chain: s.json.data.chain, submitted: s.json.data.contract };
}

test('US-A1：editor 提交生成审批链，金额分级到链级别，outbox 记 approval.requested', async (t) => {
  const { base, outbox } = await setup(t);
  const one = await newSubmittedContract(base, 1_500_000);
  assert.equal(one.submitted.status, 'in_review');
  assert.equal(one.chain.steps.length, 1);
  assert.equal(one.chain.steps[0].role, 'admin');
  const two = await newSubmittedContract(base, 20_000_000);
  assert.deepEqual(two.chain.steps.map((s) => s.role), ['admin', 'legal']);
  const pushed = await newSubmittedContract(base, 10_000_000);
  assert.equal(pushed.chain.steps.length, 2);

  const events = await outbox.list();
  const requested = events.filter((e) => e.type === 'approval.requested');
  assert.equal(requested.length, 3);
  assert.equal(requested[0].contract_id, one.contract.id);
  assert.equal(requested[0].actor_id, EDITOR.id);
  assert.ok(requested[0].at);
});

test('US-A1：非 draft 提交 → 409；viewer 提交 → 403；缺 id 提交 → 401', async (t) => {
  const { base } = await setup(t);
  const c = (await create(base, EDITOR.role, EDITOR.id)).json.data;
  const ok = await submit(base, EDITOR.role, EDITOR.id, c.id);
  assert.equal(ok.status, 200);
  assert.equal((await submit(base, EDITOR.role, EDITOR.id, c.id)).status, 409);
  const d = (await create(base, EDITOR.role, EDITOR.id)).json.data;
  assert.equal((await submit(base, VIEWER.role, VIEWER.id, d.id)).status, 403);
  assert.equal((await submit(base, EDITOR.role, null, d.id)).status, 401);
});

test('US-A2：单级链 admin 通过 → 链 approved + 合同 pending_sign + outbox approved', async (t) => {
  const { base, outbox } = await setup(t);
  const { contract } = await newSubmittedContract(base, 1_500_000);
  const r = await approve(base, ADMIN.role, ADMIN.id, contract.id, '同意');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.chain.status, 'approved');
  assert.equal(r.json.data.contract.status, 'pending_sign');
  const ev = (await outbox.list()).filter((e) => e.type === 'approval.approved');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor_id, ADMIN.id);
});

test('US-A2 自审：提交人不能审批自己 → 403', async (t) => {
  const { base, outbox } = await setup(t);
  const c = (await create(base, ADMIN.role, ADMIN.id, { ...VALID, amount: 1_500_000 })).json.data;
  const s = await submit(base, ADMIN.role, ADMIN.id, c.id);
  assert.equal(s.status, 200);
  const r = await approve(base, ADMIN.role, ADMIN.id, c.id, '自己批准');
  assert.equal(r.status, 403);
  assert.equal((await outbox.list()).filter((e) => e.type === 'approval.approved').length, 0);
});

test('US-A3：二级需 admin→legal 依次通过才进 pending_sign', async (t) => {
  const { base } = await setup(t);
  const { contract } = await newSubmittedContract(base, 20_000_000);
  // 跳过（legal 对 L1）→ 403；admin 复核 legal 步骤 → 403
  assert.equal((await approve(base, LEGAL.role, LEGAL.id, contract.id, '越级')).status, 403);
  const l1 = await approve(base, ADMIN.role, ADMIN.id, contract.id, 'L1 通过');
  assert.equal(l1.status, 200);
  assert.equal(l1.json.data.contract.status, 'in_review'); // 仍 in_review
  assert.equal((await approve(base, ADMIN.role, ADMIN.id, contract.id, '复核 legal')).status, 403);
  const l2 = await approve(base, LEGAL.role, LEGAL.id, contract.id, '复核无误');
  assert.equal(l2.status, 200);
  assert.equal(l2.json.data.chain.status, 'approved');
  assert.equal(l2.json.data.contract.status, 'pending_sign');
});

test('US-A4：驳回 → 回 draft + 链 rejected 带意见 + outbox rejected；重提为新链', async (t) => {
  const { base, outbox } = await setup(t);
  const { contract } = await newSubmittedContract(base, 20_000_000);
  const r = await reject(base, ADMIN.role, ADMIN.id, contract.id, '金额过高，需重核');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.chain.status, 'rejected');
  assert.equal(r.json.data.chain.steps[0].comment, '金额过高，需重核');
  assert.equal(r.json.data.contract.status, 'draft');
  assert.equal((await outbox.list()).filter((e) => e.type === 'approval.rejected').length, 1);
  const resub = await submit(base, EDITOR.role, EDITOR.id, contract.id);
  assert.equal(resub.status, 200);
  assert.notEqual(resub.json.data.chain.id, r.json.data.chain.id);
  assert.equal(resub.json.data.chain.status, 'pending');
  assert.equal(resub.json.data.contract.status, 'in_review');
});

test('US-A5：缺 id 审批 → 401；角色不匹配 → 403；错误信封统一', async (t) => {
  const { base } = await setup(t);
  const { contract } = await newSubmittedContract(base, 1_500_000);
  const noId = await approve(base, ADMIN.role, null, contract.id, 'x');
  assert.equal(noId.status, 401);
  assert.equal(noId.json.error.code, 'UNAUTHORIZED');
  const wrongRole = await approve(base, 'editor', EDITOR2.id, contract.id, 'x');
  assert.equal(wrongRole.status, 403);
  assert.equal(wrongRole.json.error.code, 'FORBIDDEN');
});

test('偏离④：有链的合同 in_review→pending_sign 经 /status 409；无链合同保留 admin 裸迁', async (t) => {
  const { base } = await setup(t);
  const { contract } = await newSubmittedContract(base, 20_000_000);
  const viaStatus = await req(base, 'POST', `/api/contracts/${contract.id}/status`, 'admin', ADMIN.id, { to: 'pending_sign' });
  assert.equal(viaStatus.status, 409);
  const legacy = (await create(base, ADMIN.role, ADMIN.id)).json.data;
  await req(base, 'POST', `/api/contracts/${legacy.id}/status`, 'admin', ADMIN.id, { to: 'in_review' });
  const raw = await req(base, 'POST', `/api/contracts/${legacy.id}/status`, 'admin', ADMIN.id, { to: 'pending_sign' });
  assert.equal(raw.status, 200);
  assert.equal(raw.json.data.status, 'pending_sign');
});

test('legal 可读；legal 不可提交（仅 editor/admin）', async (t) => {
  const { base } = await setup(t);
  assert.equal((await req(base, 'GET', '/api/contracts', 'legal', LEGAL.id)).status, 200);
  const c = (await create(base, EDITOR.role, EDITOR.id)).json.data;
  assert.equal((await submit(base, 'legal', LEGAL.id, c.id)).status, 403);
});

test('T3 数据源：GET /:id/approval 返回链 + 当前待决步骤；无链合同返回 null', async (t) => {
  const { base } = await setup(t);
  const d = (await create(base, EDITOR.role, EDITOR.id)).json.data;
  const none = await req(base, 'GET', `/api/contracts/${d.id}/approval`, 'viewer', VIEWER.id);
  assert.equal(none.status, 200);
  assert.equal(none.json.data.chain, null);
  assert.equal(none.json.data.current_step, null);

  const { contract } = await newSubmittedContract(base, 20_000_000);
  const ap = await req(base, 'GET', `/api/contracts/${contract.id}/approval`, 'viewer', VIEWER.id);
  assert.equal(ap.status, 200);
  assert.equal(ap.json.data.chain.contract_id, contract.id);
  assert.equal(ap.json.data.chain.steps.length, 2);
  assert.deepEqual(ap.json.data.current_step, { level: 1, role: 'admin' });
});