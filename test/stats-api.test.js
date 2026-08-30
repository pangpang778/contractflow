// test/stats-api.test.js - 统计看板 + 导出只读端点集成（S3，T2）。临时端口真实 server。
// 只测外部行为：两端点 200+形状、Content-Type、三节有序、只读无副作用、401 矩阵、空库、approvals 未接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { newContractId } from '../shared/ids.js';

const nowISO = () => new Date().toISOString();
// 本地时区 YYYY-MM-DD（"本月到期"按本地自然月判）。
function localDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function startServer(t, { withApprovals = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-stats-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const approvals = withApprovals ? await createFileStore(path.join(dir, 'approvals.json')) : null;
  const server = createApp({
    store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], approvals, staticDir: null,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, dir, store, approvals };
}

async function getJson(base, p, role) {
  const headers = {};
  if (role !== undefined) headers['X-User-Role'] = role;
  const r = await fetch(base + p, { method: 'GET', headers });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function getReport(base, p = '/api/export/report.md', role = 'viewer') {
  const headers = { 'X-User-Role': role };
  const r = await fetch(base + p, { method: 'GET', headers });
  return { status: r.status, contentType: r.headers.get('content-type') || '', body: await r.text() };
}

async function seedContract(store, overrides = {}) {
  const c = {
    id: overrides.id ?? newContractId(),
    title: '采购合同', counterparty_id: 'cp_1', amount: 1_000_000, currency: 'CNY',
    start_date: '2025-01-01', end_date: localDate(400), status: 'active',
    created_at: nowISO(), updated_at: nowISO(), ...overrides,
  };
  await store.create(c);
  return c;
}

// US-S4-① GET /api/stats 形状 + viewer 可读
test('GET /api/stats：{ok:true, data:{currency,total_cents,by_status,by_status_cents,ending_this_month}}，viewer 可读', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_draft', status: 'draft', amount: 100_000, end_date: localDate(400) });
  await seedContract(store, { id: 'c_active', status: 'active', amount: 200_000, end_date: localDate(0) });

  const r = await getJson(base, '/api/stats', 'viewer');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const d = r.json.data;
  assert.equal(d.currency, 'CNY');
  assert.equal(d.total_cents, 300_000);
  assert.equal(d.by_status.draft, 1);
  assert.equal(d.by_status.active, 1);
  assert.equal(d.by_status_cents.draft, 100_000);
  assert.equal(d.by_status_cents.active, 200_000);
  assert.ok(Array.isArray(d.ending_this_month));
  assert.equal(d.ending_this_month.length, 1);
  assert.equal(d.ending_this_month[0].id, 'c_active');
});

// US-S4-② report.md Content-Type + 三节存在且有序
test('GET /api/export/report.md：text/markdown; charset=utf-8，body 依次含统计表/即将到期/超时清单三节', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_up', title: '即将到期合同', status: 'active', amount: 123_456, end_date: localDate(0) });

  const r = await getReport(base);
  assert.equal(r.status, 200);
  assert.ok(r.contentType.startsWith('text/markdown'), `Content-Type 应为 text/markdown，实际 ${r.contentType}`);
  assert.ok(r.contentType.includes('charset=utf-8'));
  assert.ok(typeof r.body === 'string' && r.body.length > 0, '报告应为非空字符串');

  const iStats = r.body.indexOf('## 状态统计');
  const iUpcoming = r.body.indexOf('## 即将到期明细');
  const iOverdue = r.body.indexOf('## 超时清单');
  assert.ok(iStats >= 0, '应含统计表节');
  assert.ok(iUpcoming > iStats, '即将到期节应在统计表之后');
  assert.ok(iOverdue > iUpcoming, '超时清单节应在即将到期之后');

  assert.ok(r.body.includes('| 合计 |'), '统计表应含合计行');
  assert.ok(r.body.includes('即将到期合同'), '即将到期明细应含种子合同标题');
  assert.ok(r.body.includes('1,234.56'), '金额分->元千分位展示');
  assert.ok(r.body.includes('无超时审批链。'), '空超时清单应显式标注');
});

// US-S4-② 只读无副作用：store 文件字节级不变、目录不新增文件
test('只读无副作用：命中两端点后 store 文件内容字节不变、无新文件', async (t) => {
  const { base, dir, store } = await startServer(t);
  await seedContract(store, { id: 'c_ro', title: '只读验证' });
  const contractsPath = path.join(dir, 'contracts.json');

  const beforeFiles = (await fs.readdir(dir)).sort();
  const before = await fs.readFile(contractsPath);

  const stats = await getJson(base, '/api/stats', 'viewer');
  assert.equal(stats.status, 200);
  const report = await getReport(base);
  assert.equal(report.status, 200);

  const afterFiles = (await fs.readdir(dir)).sort();
  const after = await fs.readFile(contractsPath);
  assert.deepEqual(beforeFiles, afterFiles, '目录不应新增任何文件');
  assert.ok(before.equals(after), 'contracts.json 应字节级一致（只读）');
  assert.equal((await store.list()).length, 1, '不新增合同行');
});

// US-S4-③④ 身份矩阵：无头/空头/未知角色 -> 401，绝不落入业务分支
test('无 X-User-Role / 空头 / 未知角色 -> 两端点均 401 错误信封，不产出业务数据', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_auth' });

  for (const role of [undefined, '', 'hacker']) {
    const stats = await getJson(base, '/api/stats', role);
    assert.equal(stats.status, 401, `/api/stats 角色 ${JSON.stringify(role)} 应 401`);
    assert.equal(stats.json.ok, false);
    assert.equal(stats.json.error.code, 'UNAUTHORIZED');
    assert.equal(stats.json.data, undefined, '错误信封不应携带业务数据');
  }

  for (const role of [undefined, '', 'hacker']) {
    const headers = {};
    if (role !== undefined) headers['X-User-Role'] = role;
    const r = await fetch(base + '/api/export/report.md', { method: 'GET', headers });
    assert.equal(r.status, 401, `report.md 角色 ${JSON.stringify(role)} 应 401`);
    const body = await r.json().catch(() => null);
    assert.ok(body && body.ok === false && body.error.code === 'UNAUTHORIZED', '401 应为 JSON 错误信封');
  }
});

// 空库：两端点 200，不崩
test('空库：/api/stats 与 /api/export/report.md 均 200，报告为合法字符串', async (t) => {
  const { base } = await startServer(t);
  const stats = await getJson(base, '/api/stats', 'viewer');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.data.total_cents, 0);
  assert.deepEqual(stats.json.data.ending_this_month, []);

  const report = await getReport(base);
  assert.equal(report.status, 200);
  assert.ok(report.contentType.startsWith('text/markdown'));
  assert.ok(report.body.includes('## 状态统计'));
  assert.ok(report.body.includes('无超时审批链。'));
});

// 验收条件 4：approvals 未接线（smoke 形态）-> report 空超时清单而非 500
test('approvals 未接线：report.md 仍 200，超时清单为空而非 500', async (t) => {
  const { base, store } = await startServer(t, { withApprovals: false });
  await seedContract(store, { id: 'c_noappr', status: 'active', end_date: localDate(5) });

  const stats = await getJson(base, '/api/stats', 'viewer');
  assert.equal(stats.status, 200, '/api/stats 不依赖 approvals');

  const report = await getReport(base);
  assert.equal(report.status, 200, 'approvals 缺席不应 500');
  assert.ok(report.body.includes('无超时审批链。'), '超时清单应为空标注');
});

// 错误信封约定：未知路由走统一 {ok,data,error} JSON 信封（与既有端点一致）
test('未知 API 路由 -> 统一 {ok,data,error} 错误信封，不抛栈', async (t) => {
  const { base } = await startServer(t);
  const r = await getJson(base, '/api/stats/nope', 'viewer');
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.error && typeof r.json.error.code === 'string');
});
