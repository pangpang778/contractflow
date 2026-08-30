// test/search-api.test.js — 全文搜索只读端点集成（S3+S4，T3）。临时端口真实 server。
// 只测外部行为：viewer 200 分组、无 q 400、未认证 401、status 过滤、只读无副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { newContractId } from '../shared/ids.js';
import { bootSessions, authClient } from './_session-helpers.js';

const _clients = new Map();
const bearerClient = async (base) => { if (!_clients.has(base)) _clients.set(base, await authClient(base)); return _clients.get(base); };

const nowISO = () => new Date().toISOString();

async function startServer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-search-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const sessions = await bootSessions(dir);
  const server = createApp({
    store,
    counterparties: [
      { id: 'cp_1', name: '示例供应商', credit_code: '91310000ABCDEF1234', updated_at: nowISO() },
      { id: 'cp_2', name: 'Acme 海外贸易', credit_code: '91310000AABBCCDD11', updated_at: nowISO() },
    ],
    approvals: null, sessions, staticDir: null, rates: { base: 'CNY', rates: { USD: 7_200_000, EUR: 7_820_000 } },
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, dir, store };
}

async function getJson(base, p, role) {
  const r = await (await bearerClient(base)).raw('GET', p, role ?? null); // role 空 → 无 Bearer
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function seedContract(store, overrides = {}) {
  const c = {
    id: overrides.id ?? newContractId(),
    title: '采购合同', counterparty_id: 'cp_1', amount: 1_000_000, currency: 'CNY',
    start_date: '2025-01-01', end_date: '2030-01-01', status: 'active', description: '整批木制货架',
    created_at: nowISO(), updated_at: nowISO(), ...overrides,
  };
  await store.create(c);
  return c;
}

// viewer 200 + 跨合同标题/相对方名命中 + 分组形状
test('viewer GET /api/search：200 分组，标题命中合同、相对方名命中相对方', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_shelf', title: '市集货架采购', status: 'active' });
  await seedContract(store, { id: 'c_acme', title: '设备采购', counterparty_id: 'cp_2', status: 'draft', description: '' });

  const hitTitle = await getJson(base, '/api/search?q=' + encodeURIComponent('货架'), 'viewer');
  assert.equal(hitTitle.status, 200);
  assert.equal(hitTitle.json.ok, true);
  assert.deepEqual(hitTitle.json.data.contracts.map((x) => x.id), ['c_shelf']);
  assert.equal(hitTitle.json.data.counterparties.length, 0);

  const hitCp = await getJson(base, '/api/search?q=' + encodeURIComponent('Acme'), 'viewer');
  assert.equal(hitCp.status, 200);
  assert.equal(hitCp.json.data.counterparties.length, 1);
  assert.equal(hitCp.json.data.counterparties[0].id, 'cp_2');
  assert.deepEqual(hitCp.json.data.contracts.map((x) => x.id), ['c_acme']); // 相对方名也命中其合同
});

test('status 过滤叠加：仅返回该状态下合同', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_a', title: '市集采购', status: 'active' });
  await seedContract(store, { id: 'c_d', title: '市集采购二号', status: 'draft' });

  const r = await getJson(base, '/api/search?q=' + encodeURIComponent('市集') + '&status=active', 'viewer');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.contracts.map((x) => x.id), ['c_a']);
});

test('无 q / 空 q：400 BAD_REQUEST，不产出数据', async (t) => {
  const { base } = await startServer(t);
  for (const p of ['/api/search', '/api/search?q=', '/api/search?q=%20%20']) {
    const r = await getJson(base, p, 'viewer');
    assert.equal(r.status, 400, p);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'BAD_REQUEST');
  }
});

test('未认证 / 坏 token：401 错误信封，不落到业务分支', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_auth' });

  for (const h of [{}, { Authorization: 'Bearer' }, { Authorization: 'Bearer ' + 'a'.repeat(64) }]) {
    const r = await fetch(base + '/api/search?q=采购', { headers: { 'Content-Type': 'application/json', ...h } });
    assert.equal(r.status, 401, JSON.stringify(h));
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.error.code, 'UNAUTHORIZED');
    assert.equal(j.data, undefined);
  }

  // 对照：有效 viewer → 200
  const client = await bearerClient(base);
  assert.equal((await client.raw('GET', '/api/search?q=采购', 'viewer')).status, 200);
});

test('只读无副作用：命中搜索后 contracts.json 字节级不变，不新增文档', async (t) => {
  const { base, dir, store } = await startServer(t);
  await seedContract(store, { id: 'c_ro', title: '只读搜索合同' });
  const contractsPath = path.join(dir, 'contracts.json');

  const beforeFiles = (await fs.readdir(dir)).sort();
  const before = await fs.readFile(contractsPath);
  const r = await getJson(base, '/api/search?q=' + encodeURIComponent('只读'), 'viewer');
  assert.equal(r.status, 200);
  const afterFiles = (await fs.readdir(dir)).sort();

  assert.ok(before.equals(await fs.readFile(contractsPath)), 'contracts.json 应字节级一致');
  const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f));
  assert.deepEqual(newFiles, ['sessions.json'], '唯一新增 = 会话持久化产物（登录鉴权既定写入）');
  assert.equal((await store.list()).length, 1, '不新增合同行');
});