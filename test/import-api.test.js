// test/import-api.test.js — CSV 批量导入端点（S6，T6）：成功建合同+相对方自动建、错误行报告不中断、权限。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { bootSessions, authClient } from './_session-helpers.js';

const nowISO = () => new Date().toISOString();
const HEADER = '编号,标题,相对方名,金额(分),币种,到期日';

async function startServer(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-import-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const counterpartiesStore = await createFileStore(path.join(dir, 'counterparties.json'));
  const sessions = await bootSessions(dir);
  const server = createApp({
    store, counterparties: counterpartiesStore, sessions, staticDir: null,
    ...overrides,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = await authClient(base);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, client, store, counterpartiesStore, dir };
}

const importCsv = async (client, csv, role = 'editor') =>
  client.reqJson('POST', '/api/contracts/import', role, csv);

test('成功导入：建 2 合同（USD + 空币种→CNY）+ 同名相对方只自动建一个；可查回', async (t) => {
  const { client, counterpartiesStore } = await startServer(t);
  const csv = `${HEADER}\nHT-001,采购A,供应商甲,1500000,USD,2027-09-01\nHT-002,采购B,供应商甲,200000,,2027-10-01`;

  const r = await importCsv(client, csv);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.data.total, 2);
  assert.equal(r.json.data.succeeded, 2);
  assert.equal(r.json.data.failed, 0);
  assert.deepEqual(r.json.data.created_contract_ids, ['HT-001', 'HT-002']);
  assert.equal(r.json.data.created_counterparty_ids.length, 1, '同名相对方只建一个');

  const cps = await counterpartiesStore.list();
  assert.equal(cps.length, 1);
  assert.equal(cps[0].name, '供应商甲');
  assert.equal(cps[0].credit_code, '', '自动相对方无信用代码');

  // 可经详情查回（id=编号），币种/到期日正确
  const c1 = await client.reqJson('GET', '/api/contracts/HT-001', 'viewer');
  assert.equal(c1.status, 200);
  assert.equal(c1.json.data.amount, 1_500_000);
  assert.equal(c1.json.data.currency, 'USD');
  assert.equal(c1.json.data.end_date, '2027-09-01');
  assert.equal(c1.json.data.start_date, new Date().toISOString().slice(0, 10), 'start_date=导入当日');
  const c2 = await client.reqJson('GET', '/api/contracts/HT-002', 'viewer');
  assert.equal(c2.json.data.currency, 'CNY', '空币种默认 CNY');
});

test('错误行不中断整批：坏金额/非法币种/坏日期/批内编号重复入报告，合法行走', async (t) => {
  const { client, store } = await startServer(t);
  const csv = [
    HEADER,
    'OK-1,合法合同,乙公司,300000,CNY,2027-09-01',
    'BAD-1,坏金额,乙公司,-5,CNY,2027-09-01',
    'BAD-2,坏币种,乙公司,100,GBP,2027-09-01',
    'BAD-3,坏日期,乙公司,100,CNY,2027/09/01',
    'OK-2,再一条,乙公司,400000,CNY,2027-10-01',
    'OK-1,重复编号,乙公司,100,CNY,2027-11-01',
  ].join('\n');

  const r = await importCsv(client, csv);
  assert.equal(r.status, 201);
  assert.equal(r.json.data.total, 6);
  assert.equal(r.json.data.succeeded, 2, 'OK-1 与 OK-2 建成');
  assert.equal(r.json.data.failed, 4, '4 行违规');
  const reasons = r.json.data.failures.map((f) => f.reason).join('|');
  assert.match(reasons, /金额/);
  assert.match(reasons, /币种/);
  assert.match(reasons, /YYYY-MM-DD/);
  assert.match(reasons, /编号重复/);
  assert.ok(r.json.data.failures.every((f) => Number.isInteger(f.line)), '每失败行带行号');

  const created = (await store.list()).map((c) => c.id);
  assert.ok(created.includes('OK-1') && created.includes('OK-2'), '合法行不受违规行影响');
  assert.ok(!created.some((id) => id.startsWith('BAD-')), '违规行不入库');

  // 同一批合法行共用同一自动相对方（乙公司）
  const cps = await client.reqJson('GET', '/api/counterparties', 'viewer');
  assert.equal(cps.json.data.filter((c) => c.name === '乙公司').length, 1);
});

test('库内编号重复：已有合同 id 再导入 → 该行失败', async (t) => {
  const { client, store } = await startServer(t);
  await store.create({
    id: 'EXIST-1', title: '既有', counterparty_id: 'cp_x', amount: 100, currency: 'CNY',
    start_date: '2025-01-01', end_date: '2028-01-01', status: 'active', created_at: nowISO(), updated_at: nowISO(),
  });
  const csv = `${HEADER}\nEXIST-1,抢编号,某公司,100,CNY,2027-09-01`;
  const r = await importCsv(client, csv);
  assert.equal(r.json.data.failed, 1);
  assert.match(r.json.data.failures[0].reason, /库内/);
});

test('表头不精确匹配 → 400 INVALID_HEADER；坏 CSV（引号未闭合）→ 400 BAD_CSV', async (t) => {
  const { client } = await startServer(t);
  const badHeader = '编号,标题,相对方名,金额,币种,到期日\nOK-1,内容,乙,100,CNY,2027-09-01';
  const r1 = await importCsv(client, badHeader);
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error.code, 'INVALID_HEADER');

  const badQuote = `${HEADER}\n"未闭合,乙,100,CNY,2027-09-01`;
  const r2 = await importCsv(client, badQuote);
  assert.equal(r2.status, 400);
  assert.equal(r2.json.error.code, 'BAD_CSV');
});

test('角色：viewer/legal 导入 → 403；editor/admin 可导入', async (t) => {
  const { client } = await startServer(t);
  const csv = `${HEADER}\nX-1,内容,某,100,CNY,2027-09-01`;
  assert.equal((await importCsv(client, csv, 'viewer')).status, 403);
  assert.equal((await importCsv(client, csv, 'legal')).status, 403);
  assert.equal((await importCsv(client, csv, 'editor')).status, 201);
});