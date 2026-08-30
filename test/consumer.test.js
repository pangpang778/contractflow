// test/consumer.test.js — outbox 消费状态机 + buildVars + mails 存储回环（S3，T2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/store.js';
import { nextMailState, buildVars, MAX_RETRY } from '../shared/consumer.js';
import { renderTemplate } from '../shared/mail.js';

test('MAX_RETRY = 3', () => {
  assert.equal(MAX_RETRY, 3);
});

// —— US-E3 S3 状态机 ——
test('pending → 渲染成功 → sent（retry 沿用 0/既有值）', () => {
  assert.deepEqual(nextMailState({}, true), { status: 'sent', retry_count: 0 });
  assert.deepEqual(nextMailState({ status: 'pending', retry_count: 0 }, true), { status: 'sent', retry_count: 0 });
});

test('pending → 渲染失败 → failed + retry+1', () => {
  assert.deepEqual(nextMailState({ status: 'pending', retry_count: 0 }, false), { status: 'failed', retry_count: 1 });
});

test('failed retry<3 → 重试成功转 sent', () => {
  assert.deepEqual(nextMailState({ status: 'failed', retry_count: 1 }, true), { status: 'sent', retry_count: 1 });
  assert.deepEqual(nextMailState({ status: 'failed', retry_count: 2 }, true), { status: 'sent', retry_count: 2 });
});

test('retry>=3 再失败 → 保持 failed、不再递增（退避上限）', () => {
  const capped = nextMailState({ status: 'failed', retry_count: 2 }, false);
  assert.deepEqual(capped, { status: 'failed', retry_count: 3 });
  const stayed = nextMailState({ status: 'failed', retry_count: 3 }, false);
  assert.deepEqual(stayed, { status: 'failed', retry_count: 3 });
});

test('已 sent 不再迁移（幂等）', () => {
  assert.deepEqual(nextMailState({ status: 'sent', retry_count: 0 }, false), { status: 'sent', retry_count: 0 });
  assert.deepEqual(nextMailState({ status: 'sent', retry_count: 0 }, true), { status: 'sent', retry_count: 0 });
});

// —— buildVars ——
const CONTRACT = { title: '采购合同', amount: 15_000_000, counterparty_id: 'cp_1', end_date: '2027-09-01' };

test('approval 事件：buildVars 用合同补全 title/amount_yuan/counterparty_id/end_date', () => {
  const vars = buildVars({ type: 'approval.requested', contract_id: 'c1' }, CONTRACT);
  assert.equal(vars.title, '采购合同');
  assert.equal(vars.amount_yuan, '150000'); // 15_000_000 分 = 150000 元
  assert.equal(vars.counterparty_id, 'cp_1');
  assert.equal(vars.end_date, '2027-09-01');
  // 补全后可渲染出主题含标题
  const { subject } = renderTemplate('approval.requested', vars);
  assert.match(subject, /采购合同/);
});

test('reminder 事件：payload 自带整组字段，透传并合并合同档', () => {
  const vars = buildVars({ type: 'reminder.due', payload: { title: 'R', days_left: 5, due_date: '2026-09-15' } }, CONTRACT);
  assert.equal(vars.days_left, 5);
  assert.equal(vars.due_date, '2026-09-15');
  assert.equal(vars.title, 'R');
  assert.equal(vars.amount_yuan, '150000'); // 来自合同合并
});

test('buildVars：amount 非整数 → amount_yuan 空串；contract 为 null → 空对象', () => {
  assert.equal(buildVars({ type: 'x' }, { amount: 12.5 }).amount_yuan, '');
  assert.deepEqual(buildVars({ type: 'x' }, null), {});
});

// —— mails 存储接线：记录 id 即去重 key（createFileStore 按 id 键控），可 get/去重 ——
test('mails store 以 id(=去重 key) 读写回环；重复 id 拒绝', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-mails-'));
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mails = await createFileStore(path.join(dir, 'mails.json'));
  const rec = { id: 'c1:30', type: 'reminder.due', contract_id: 'c1', recipient_hint: '', subject: 's', body: 'b', sent_at: new Date().toISOString() };
  await mails.create(rec);
  assert.equal((await mails.get('c1:30')).subject, 's');
  assert.ok((await mails.get('c1:30')).id === 'c1:30', '记录 id 即去重 key');
  await assert.rejects(() => mails.create(rec), { code: 'CONFLICT' }, '重复去重 key 应被拒');
  assert.equal((await mails.list()).length, 1);
});