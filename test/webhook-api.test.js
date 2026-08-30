// test/webhook-api.test.js — webhook 配置 CRUD + 试投 + 事件接入 + 消费（S3+S2，T2/T3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { bootSessions, authClient } from './_session-helpers.js';

const nowISO = () => new Date().toISOString();

async function startServer(t, fetchImpl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-webhook-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const approvals = await createFileStore(path.join(dir, 'approvals.json'));
  const outbox = await createFileStore(path.join(dir, 'outbox.json'));
  const amendments = await createFileStore(path.join(dir, 'amendments.json'));
  const webhooks = await createFileStore(path.join(dir, 'webhooks.json'));
  const webhookDeliveries = await createFileStore(path.join(dir, 'webhook_deliveries.json'));
  const sessions = await bootSessions(dir);
  const counterparties = [
    { id: 'cp_1', name: '示例供应商', credit_code: '91310000ABCDEF1234', risk_rating: 'C', created_at: nowISO(), updated_at: nowISO() },
  ];
  const server = createApp({
    store, counterparties, approvals, outbox, amendments,
    webhooks, webhookDeliveries, sessions, staticDir: null, fetchImpl,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = await authClient(base);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, client, store, approvals, outbox, amendments, webhooks, webhookDeliveries, dir };
}

// 可注入 mock fetch：记录调用，可切失败。缺省成功 200。
function makeFetch() {
  const calls = [];
  let fail = false;
  const impl = async (url, opts) => { calls.push({ url, opts }); return fail ? { ok: false, status: 500 } : { ok: true, status: 200 }; };
  impl.calls = calls;
  impl.setFail = (f) => { fail = f; };
  return impl;
}

// —— T2 CRUD ——
test('CRUD：admin 建/查（secret 掩码）/改/删；GET 绝不回 secret', async (t) => {
  const { base, client } = await startServer(t, makeFetch());

  const created = await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hook.example.com/x', secret: 's3cr3t', name: '客户A' });
  assert.equal(created.status, 201);
  const wh = created.json.data;
  assert.equal(wh.has_secret, true);
  assert.equal(wh.secret, undefined, 'create 响应不回 secret');

  const list = await client.reqJson('GET', '/api/webhooks', 'admin');
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].has_secret, true);
  assert.equal('secret' in list.json.data[0], false, 'list 响应不含 secret 键');

  const patch = await client.reqJson('PATCH', `/api/webhooks/${wh.id}`, 'admin', { enabled: false });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.data.enabled, false);

  const del = await client.reqJson('DELETE', `/api/webhooks/${wh.id}`, 'admin');
  assert.equal(del.status, 204);
  assert.equal((await client.reqJson('GET', '/api/webhooks', 'admin')).json.data.length, 0);
});

test('CRUD：url 非 http(s) / secret 空 → 400；角色 admin 外一律 403', async (t) => {
  const { base, client } = await startServer(t, makeFetch());
  for (const body of [{ url: 'ftp://x', secret: 's' }, { url: 'https://x', secret: '' }]) {
    const r = await client.reqJson('POST', '/api/webhooks', 'admin', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.ok, false);
  }
  const badUrl = await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'not-a-url', secret: 's' });
  assert.equal(badUrl.status, 400);

  for (const role of ['viewer', 'editor', 'legal']) {
    assert.equal((await client.reqJson('GET', '/api/webhooks', role)).status, 403, `${role} GET`);
    assert.equal((await client.reqJson('POST', '/api/webhooks', role, { url: 'https://x', secret: 's' })).status, 403, `${role} POST`);
  }
});

test('测试发送：admin POST /:id/test 同步投 webhook.test，注入 fetch 捕获', async (t) => {
  const fetchImpl = makeFetch();
  const { base, client } = await startServer(t, fetchImpl);
  const wh = (await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/hook', secret: 'sec' })).json.data;

  const r = await client.reqJson('POST', `/api/webhooks/${wh.id}/test`, 'admin');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.sent, true);
  assert.equal(fetchImpl.calls.length, 1);
  const sent = fetchImpl.calls[0];
  assert.equal(sent.opts.method, 'POST');
  assert.ok(sent.opts.headers['X-ContractFlow-Signature'], '带签名头');
  assert.ok(sent.opts.headers['X-ContractFlow-Timestamp'], '带时间戳头');
  assert.match(JSON.parse(sent.opts.body).event.type, /webhook\.test/);

  const notFound = await client.reqJson('POST', '/api/webhooks/nope/test', 'admin');
  assert.equal(notFound.status, 404);
});

// —— T3 事件接入 ——
async function seedContract(client, overrides = {}) {
  const r = await client.reqJson('POST', '/api/contracts', 'editor', {
    title: '采购合同', counterparty_id: 'cp_1', amount: 1_000_000, currency: 'USD',
    start_date: '2025-01-01', end_date: '2030-01-01', ...overrides,
  });
  return r.json.data;
}

test('事件接入：建合同 → contract.created 入队；consume（fetch 成功）→ sent', async (t) => {
  const fetchImpl = makeFetch();
  const { client, webhooks, webhookDeliveries } = await startServer(t, fetchImpl);
  await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/a', secret: 's1' });

  const c = await seedContract(client);
  const jobs = await webhookDeliveries.list();
  assert.equal(jobs.length, 1, 'enabled webhook 落一条作业');
  assert.equal(jobs[0].event_type, 'contract.created');
  assert.equal(jobs[0].event.contract_id, c.id);
  assert.equal(jobs[0].status, 'pending');

  const r = await client.reqJson('POST', '/api/webhooks/consume', 'editor');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.sent, 1);
  assert.equal(r.json.data.outbox.sent, 1);
  assert.equal((await webhookDeliveries.get(jobs[0].id)).status, 'sent');
});

test('事件接入：禁用 webhook 不落作业；无 webhook 时 consume 空转', async (t) => {
  const fetchImpl = makeFetch();
  const { client, webhookDeliveries } = await startServer(t, fetchImpl);
  const wh = (await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/a', secret: 's1' })).json.data;
  await client.reqJson('PATCH', `/api/webhooks/${wh.id}`, 'admin', { enabled: false });

  await seedContract(client);
  assert.equal((await webhookDeliveries.list()).length, 0, '禁用不落作业');

  const r = await client.reqJson('POST', '/api/webhooks/consume', 'editor');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.processed, 0);
});

test('审批事件接入：submit→approval.requested、approve→approval.approved、reject→approval.rejected', async (t) => {
  const fetchImpl = makeFetch();
  const { client, webhookDeliveries } = await startServer(t, fetchImpl);
  await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/a', secret: 's1' });

  const c = await seedContract(client);
  await client.reqJson('POST', `/api/contracts/${c.id}/submit`, 'editor', {});
  assert.ok((await webhookDeliveries.list()).some((j) => j.event_type === 'approval.requested'), 'submit 入 approval.requested');

  // editor 提交，admin 通过（提交人 ≠ 审批人，走真实链）。
  await client.reqJson('POST', `/api/contracts/${c.id}/approve`, 'admin', { comment: 'ok' });
  assert.ok((await webhookDeliveries.list()).some((j) => j.event_type === 'approval.approved'), 'approve 入 approval.approved');

  const c2 = await seedContract(client, { title: '驳回合同' });
  await client.reqJson('POST', `/api/contracts/${c2.id}/submit`, 'editor', {});
  await client.reqJson('POST', `/api/contracts/${c2.id}/reject`, 'admin', { comment: '不行' });
  assert.ok((await webhookDeliveries.list()).some((j) => j.event_type === 'approval.rejected'), 'reject 入 approval.rejected');
});

test('变更单事件接入：apply → amendment.applied（预置 approved 变更单 + active 父合同）', async (t) => {
  const fetchImpl = makeFetch();
  const { client, store, amendments, webhookDeliveries } = await startServer(t, fetchImpl);
  await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/a', secret: 's1' });

  // active 父合同
  const parent = await seedContract(client, { title: '父合同' });
  await store.update(parent.id, (cur) => ({ ...cur, status: 'active' }));
  // approved 变更单
  const am = (await amendments.create({
    id: 'am_ok', parent_contract_id: parent.id, reason: '调价',
    changes: { amount: 2_000_000 }, status: 'approved', approver_id: 'u_admin', decided_at: nowISO(), created_at: nowISO(), updated_at: nowISO(),
  })).id;
  const r = await client.reqJson('POST', `/api/amendments/${am}/apply`, 'admin', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));

  assert.ok((await webhookDeliveries.list()).some((j) => j.event_type === 'amendment.applied'), 'apply 入 amendment.applied');
});

// —— T3 消费：失败重试 → 死信 ——
test('消费失败走退避：连续 fail → attempts 递增、第 4 次灭死信；已 sent 幂等', async (t) => {
  const fetchImpl = makeFetch();
  const { client, webhookDeliveries, store } = await startServer(t, fetchImpl);
  await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/fail', secret: 's1' });
  await seedContract(client);
  const jobId = (await webhookDeliveries.list())[0].id;
  fetchImpl.setFail(true);

  const forceRetry = async () => {
    const j = await webhookDeliveries.get(jobId);
    await webhookDeliveries.update(jobId, (cur) => ({ ...cur, next_retry_at: Date.now() - 1 }));
    return (await client.reqJson('POST', '/api/webhooks/consume', 'editor')).json.data;
  };

  const r1 = await forceRetry();
  assert.equal(r1.failed, 1);
  assert.equal((await webhookDeliveries.get(jobId)).attempts, 1);

  await forceRetry(); // attempts 2
  await forceRetry(); // attempts 3
  const r4 = await forceRetry(); // attempts 4 > 3 → dead
  assert.equal(r4.dead, 1);
  assert.equal((await webhookDeliveries.get(jobId)).status, 'dead');
  assert.equal((await webhookDeliveries.get(jobId)).attempts, 4);

  // 死信后再 consume 不再动（幂等）
  const again = await client.reqJson('POST', '/api/webhooks/consume', 'editor');
  assert.equal(again.json.data.processed, 0);
});

test('webhook 被删/禁用后遗留作业 → consume 直接死信', async (t) => {
  const fetchImpl = makeFetch();
  const { client, webhooks, webhookDeliveries } = await startServer(t, fetchImpl);
  const wh = (await client.reqJson('POST', '/api/webhooks', 'admin', { url: 'https://hw.example/x', secret: 's1' })).json.data;
  await seedContract(client);
  await client.reqJson('DELETE', `/api/webhooks/${wh.id}`, 'admin');

  const r = await client.reqJson('POST', '/api/webhooks/consume', 'editor');
  assert.equal(r.json.data.dead, 1);
  assert.equal((await webhookDeliveries.list())[0].status, 'dead');
});

test('角色：viewer/legal 调 consume → 403；editor 可触发', async (t) => {
  const { client } = await startServer(t, makeFetch());
  assert.equal((await client.reqJson('POST', '/api/webhooks/consume', 'viewer')).status, 403);
  assert.equal((await client.reqJson('POST', '/api/webhooks/consume', 'legal')).status, 403);
  assert.equal((await client.reqJson('POST', '/api/webhooks/consume', 'editor')).status, 200);
});