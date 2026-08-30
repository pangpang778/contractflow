// test/reminder-api.test.js — 到期提醒 + outbox 消费 API 集成（S4，T3）。临时端口真实 server。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { newContractId } from '../shared/ids.js';

const nowISO = () => new Date().toISOString();
const dateFromToday = (offsetDays) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-rm-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const approvals = await createFileStore(path.join(dir, 'approvals.json'));
  const outbox = await createFileStore(path.join(dir, 'outbox.json'));
  const mails = await createFileStore(path.join(dir, 'mails.json'));
  const server = createApp({
    store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], approvals, outbox, mails, staticDir: null,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, store, approvals, outbox, mails };
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
const consume = (b, role = 'editor', id = 'u_1') => req(b, 'POST', '/api/outbox/consume', role, id);
const due = (b, role = 'viewer', id = 'u_a') => req(b, 'GET', '/api/reminders/due', role, id);
const outboxView = (b, role = 'viewer', id = 'u_a') => req(b, 'GET', '/api/outbox', role, id);

async function seedContract(store, overrides = {}) {
  const c = {
    id: overrides.id ?? newContractId(),
    title: '采购合同', counterparty_id: 'cp_1', amount: 15_000_000, currency: 'CNY',
    start_date: '2025-01-01', end_date: dateFromToday(400), status: 'active',
    created_at: nowISO(), updated_at: nowISO(), ...overrides,
  };
  await store.create(c);
  return c;
}

test('US-E5-① GET /api/reminders/due 返回纯扫描清单，不写任何存储', async (t) => {
  const { base, store, outbox, mails } = await setup(t);
  await seedContract(store, { id: 'cdue', end_date: dateFromToday(22) });
  const r = await due(base);
  assert.equal(r.status, 200);
  const hit = r.json.data.find((x) => x.contract_id === 'cdue');
  assert.ok(hit, '应含 22 天合同的 30 档提醒');
  assert.equal(hit.tier, 30);
  assert.equal(hit.due_date, dateFromToday(22));
  assert.deepEqual(await mails.list(), [], '不写已发送队列');
  assert.equal((await outbox.list()).length, 0, '不改 outbox');
});

test('US-E4-① consume 渲染 pending 审批事件 → mails 落盘 + outbox 事件标 sent', async (t) => {
  const { base, store, outbox, mails } = await setup(t);
  const c = await seedContract(store, { id: 'cok', title: '审批合同' });
  await outbox.create({ id: 'evt_ok', type: 'approval.requested', contract_id: c.id, actor_id: 'u_9', at: nowISO() });
  const r = await consume(base);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const evt = (await outbox.list())[0];
  assert.equal(evt.status, 'sent');
  assert.equal(evt.retry_count, 0);
  const mail = (await mails.list()).find((m) => m.id === 'evt_ok');
  assert.ok(mail, '已发送队列应有该事件记录');
  assert.match(mail.subject, /审批合同/);
  assert.ok(mail.body.includes('¥150000'), '金额分→元串化');
});

test('US-E4-③ consume 同时扫到期提醒并落 reminder.due 邮件', async (t) => {
  const { base, store, mails } = await setup(t);
  await seedContract(store, { id: 'cdue', end_date: dateFromToday(5) });
  const r = await consume(base);
  assert.equal(r.status, 200);
  const mail = (await mails.list()).find((m) => m.id === 'cdue:7');
  assert.ok(mail, '应落 7 档提醒邮件');
  assert.equal(mail.type, 'reminder.due');
  assert.match(mail.body, /5/);
});

test('US-E4-④ 幂等：重复 consume 不产生重复 sent 记录', async (t) => {
  const { base, store, mails } = await setup(t);
  await seedContract(store, { id: 'cdue', end_date: dateFromToday(5) });
  await consume(base);
  const before = (await mails.list()).length;
  await consume(base);
  assert.equal((await mails.list()).length, before, '重复触发不重复写');
});

test('US-E3 渲染失败 → failed + retry 递增；退避上限后不再递增', async (t) => {
  const { base, outbox, mails } = await setup(t);
  await outbox.create({ id: 'evt_bad', type: 'no.such.type', contract_id: 'cx', at: nowISO() });
  await consume(base);
  let evt = (await outbox.list())[0];
  assert.equal(evt.status, 'failed');
  assert.equal(evt.retry_count, 1);
  assert.equal((await mails.list()).length, 0, '失败不写已发送');
  await consume(base);
  evt = (await outbox.list())[0];
  assert.equal(evt.retry_count, 2);
  // 到上限后保持 failed 不再递增
  await consume(base);
  await consume(base);
  evt = (await outbox.list())[0];
  assert.equal(evt.status, 'failed');
  assert.ok(evt.retry_count <= 3);
});

test('US-E5-② GET /api/outbox 按 pending/sent/failed 分组', async (t) => {
  const { base, store, outbox } = await setup(t);
  const c = await seedContract(store, { id: 'cok', title: 'A' });
  await outbox.create({ id: 'evt_sent', type: 'approval.approved', contract_id: c.id, at: nowISO() });
  await outbox.create({ id: 'evt_bad', type: 'no.such.type', contract_id: 'cx', at: nowISO() });
  await consume(base); // evt_sent → sent、evt_bad → failed
  await outbox.create({ id: 'evt_pend', type: 'approval.requested', contract_id: c.id, at: nowISO() }); // 消费后新增 → 仍 pending
  const r = await outboxView(base);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.data).sort(), ['failed', 'pending', 'sent']);
  assert.equal(r.json.data.sent.map((e) => e.id).includes('evt_sent'), true);
  assert.equal(r.json.data.failed[0].id, 'evt_bad');
  assert.equal(r.json.data.pending[0].id, 'evt_pend');
});

test('US-E6 权限：viewer consume → 403；无身份头 GET /due → 401', async (t) => {
  const { base } = await setup(t);
  assert.equal((await consume(base, 'viewer', 'u_v')).status, 403);
  assert.equal((await due(base, null, null)).status, 401);
  assert.equal((await outboxView(base, null, null)).status, 401);
});

test('US-E6 错误信封统一：consume 未接线存储 → 404 / 未知路径 → 404', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-nomail-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const server = createApp({ store, counterparties: [], staticDir: null }); // 无 outbox/mails
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const r = await consume(base);
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'NOT_FOUND');
});