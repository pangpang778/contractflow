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
import { bootSessions, authClient } from './_session-helpers.js';

const _clients = new Map();
const bearerClient = async (base) => { if (!_clients.has(base)) _clients.set(base, await authClient(base)); return _clients.get(base); };

const nowISO = () => new Date().toISOString();
// 本地时区 YYYY-MM-DD（"本月到期"按本地自然月判）。
function localDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function startServer(t, { withApprovals = true, rates = undefined } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-stats-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const approvals = withApprovals ? await createFileStore(path.join(dir, 'approvals.json')) : null;
  const sessions = await bootSessions(dir);
  const server = createApp({
    store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], approvals, sessions, staticDir: null, rates,
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
  const r = await (await bearerClient(base)).raw('GET', p, role ?? null); // role 空 → 无 Bearer
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function getReport(base, p = '/api/export/report.md', role = 'viewer') {
  const r = await (await bearerClient(base)).raw('GET', p, role);
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
// ├ Run C S4① ┤ /api/stats 注入 rates 后外币折算为 CNY 分 + rates_used 留痕
test('GET /api/stats：传入 rates，USD/EUR 合同折算 CNY 分，total_cents 为折算后合计，rates_used 留痕', async (t) => {
  const { base, store } = await startServer(t, { rates: { base: 'CNY', rates: { USD: 7_200_000, EUR: 7_820_000 } } });
  await seedContract(store, { amount: 10000, status: 'draft', end_date: localDate(400) });
  await seedContract(store, { amount: 100, currency: 'USD', status: 'active', end_date: localDate(400) }); // 1 USD × 7.2 = 720
  await seedContract(store, { amount: 100, currency: 'EUR', status: 'active', end_date: localDate(400) }); // 1 EUR × 7.82 = 782

  const r = await getJson(base, '/api/stats', 'viewer');
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.equal(d.currency, 'CNY');
  assert.equal(d.by_status_cents.draft, 10000);
  assert.equal(d.by_status_cents.active, 720 + 782);
  assert.equal(d.total_cents, 10000 + 720 + 782);
  assert.equal(d.rates_used.USD, 7_200_000);
  assert.equal(d.rates_used.EUR, 7_820_000);
});

// ├ Run C ┤ report.md 与看板同口径：外币折算 CNY（review MEDIUM 回归锁）
test('GET /api/export/report.md：注入 rates 后，USD 合同按 CNY 折算入统计表（与 /api/stats 同口径）', async (t) => {
  const { base, store } = await startServer(t, { rates: { base: 'CNY', rates: { USD: 7_200_000 } } });
  await seedContract(store, { amount: 100, currency: 'USD', status: 'active', end_date: localDate(400) }); // $1.00 → ¥7.20

  const r = await getReport(base);
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('| 合计 | 1 | 7.20 |'), '统计表合计应为折算后 CNY（120 分→7.20），非原币 1.00');
  assert.ok(!r.body.includes('| 合计 | 1 | 1.00 |'), '不得按原币分累积（折算前口径）');
});

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
  const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f));
  assert.deepEqual(newFiles, ['sessions.json'], '唯一新增 = 会话持久化产物（登录鉴权的既定写入）；业务无副作用');
  assert.ok(before.equals(after), 'contracts.json 应字节级一致（只读）');
  assert.equal((await store.list()).length, 1, '不新增合同行');
});

// US-S4-③④ 身份矩阵：无 Bearer / 坏 token / 未知 token -> 401，绝不落入业务分支
test('无 Authorization / 格式坏 / 随机 token -> 两端点均 401 错误信封，不产出业务数据', async (t) => {
  const { base, store } = await startServer(t);
  await seedContract(store, { id: 'c_auth' });

  const badHeaders = [{}, { Authorization: 'Bearer' }, { Authorization: `Bearer ${'a'.repeat(128)}` }];
  for (const h of badHeaders) {
    const stats = await fetch(base + '/api/stats', { headers: { 'Content-Type': 'application/json', ...h } });
    assert.equal(stats.status, 401, `GET /api/stats ${JSON.stringify(h)} 应 401`);
    const j = await stats.json();
    assert.equal(j.ok, false);
    assert.equal(j.error.code, 'UNAUTHORIZED');
    assert.equal(j.data, undefined, '错误信封不应携带业务数据');

    const report = await fetch(base + '/api/export/report.md', { headers: h });
    assert.equal(report.status, 401, `report.md ${JSON.stringify(h)} 应 401`);
    const body = await report.json().catch(() => null);
    assert.ok(body && body.ok === false && body.error.code === 'UNAUTHORIZED', '401 应为 JSON 错误信封');
  }

  // 对照：有效 viewer token → 200（证明 401 是鉴权驱动，非常规故障）
  const client = await bearerClient(base);
  assert.equal((await client.raw('GET', '/api/stats', 'viewer')).status, 200);
  assert.equal((await client.raw('GET', '/api/export/report.md', 'viewer')).status, 200);
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
