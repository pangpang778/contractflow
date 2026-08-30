// test/stats.test.js — 统计聚合 + 报告数据派生（S1，pure）。
// 状态分布 / 总金额 / 按状态金额 / 本月到期 / 即将到期 / 审批链超时。时间注入，确定性。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStats,
  computeUpcoming,
  computeOverdueChains,
  STATS_SLA_DAYS,
} from '../shared/stats.js';

// 2026-09-10 居月中，时区无关地稳定为 9 月；不落月边界。
const NOW = new Date('2026-09-10T12:00:00Z');
const ZERO = { draft: 0, in_review: 0, pending_sign: 0, active: 0, archived: 0, void: 0, expired: 0 };

function mk(id, end_date, amount = 0, status = 'active') {
  return { id, title: `合同${id}`, counterparty_id: `cp_${id}`, amount, currency: 'CNY', status, end_date };
}

test('STATS_SLA_DAYS = 7', () => {
  assert.equal(STATS_SLA_DAYS, 7);
});

// ── computeStats ───────────────────────────────────────────────

test('US-S1-① 空库：by_status 全 0、total=0、by_status_cents 全 0、ending=[]，不崩', () => {
  const s = computeStats([], NOW);
  assert.equal(s.currency, 'CNY');
  assert.deepEqual(s.by_status, ZERO);
  assert.equal(s.total_cents, 0);
  assert.deepEqual(s.by_status_cents, ZERO);
  assert.deepEqual(s.ending_this_month, []);
});

test('US-S1-②③ 多状态分布 + 整数和：total_cents === Σ by_status_cents，键无缺失', () => {
  const contracts = [
    mk('a', '2026-10-01', 10005, 'draft'),
    mk('b', '2026-10-02', 20010, 'draft'),
    mk('c', '2026-10-03', 30000, 'in_review'),
    mk('d', '2026-10-04', 90000, 'active'),
    mk('e', '2026-10-05', 120000, 'archived'),
    mk('f', '2026-10-06', 70000, 'void'),
    mk('g', '2026-10-07', 80000, 'expired'),
    mk('h', '2026-10-08', 45000, 'active'),
    mk('i', '2026-10-09', 500, 'pending_sign'),
  ];
  const s = computeStats(contracts, NOW);
  assert.deepEqual(s.by_status, { draft: 2, in_review: 1, pending_sign: 1, active: 2, archived: 1, void: 1, expired: 1 });
  assert.equal(s.by_status_cents.draft, 10005 + 20010);
  assert.equal(s.by_status_cents.in_review, 30000);
  assert.equal(s.by_status_cents.pending_sign, 500);
  assert.equal(s.by_status_cents.active, 90000 + 45000);
  assert.equal(s.by_status_cents.archived, 120000);
  assert.equal(s.by_status_cents.void, 70000);
  assert.equal(s.by_status_cents.expired, 80000);
  const sum = Object.values(s.by_status_cents).reduce((a, b) => a + b, 0);
  assert.equal(s.total_cents, sum);
  assert.equal(s.total_cents, contracts.reduce((a, c) => a + c.amount, 0));
  assert.deepEqual(Object.keys(s.by_status).sort(), Object.keys(ZERO).sort());
});

test('US-S1-④ 本月到期：首日/末日计入、上月/下月排除、终态排除、按 end_date 升序', () => {
  const contracts = [
    mk('a', '2026-09-20', 10, 'active'),       // 月内 + active 计入
    mk('b', '2026-09-05', 20, 'draft'),        // 月内 + draft 计入
    mk('c', '2026-09-30', 30, 'pending_sign'), // 末日计入
    mk('d', '2026-09-15', 40, 'in_review'),    // 月内计入
    mk('e', '2026-08-31', 50, 'active'),       // 上月排除
    mk('f', '2026-10-01', 60, 'active'),       // 下月排除
    mk('g', '2026-09-10', 70, 'expired'),      // 终态排除
    mk('h', '2026-09-12', 80, 'archived'),     // 终态排除
    mk('i', '2026-09-08', 90, 'void'),         // 终态排除
    mk('j', '2026-09-02', 100, 'active'),      // 月内计入
  ];
  const ids = computeStats(contracts, NOW).ending_this_month.map((x) => x.id);
  assert.deepEqual(ids, ['j', 'b', 'd', 'a', 'c']); // 按 end_date 升序
});

// ── 多币种折算（Run C，S4）───────────────────────────────────

const RATES = { base: 'CNY', rates: { USD: 7_200_000, EUR: 7_820_000 } };

test('computeStats 折算：传入 {rates}，外币按 rate 折算 CNY 分，total_cents 为折算后合计', () => {
  const contracts = [
    mk('a', '2026-10-01', 10000, 'draft'),          // CNY → 原样
    { ...mk('b', '2026-10-02', 100, 'active'), currency: 'USD' }, // 1 USD × 7.2 = 720 分
    { ...mk('c', '2026-10-03', 100, 'active'), currency: 'EUR' }, // 1 EUR × 7.82 = 782 分
  ];
  const s = computeStats(contracts, NOW, { rates: RATES });
  assert.equal(s.currency, 'CNY');
  assert.equal(s.by_status_cents.draft, 10000);
  // by_status_cents 以折算后 CNY 分为准
  assert.equal(s.by_status_cents.active, 720 + 782);
  assert.equal(s.total_cents, 10000 + 720 + 782);
  // 汇率来源留痕
  assert.equal(s.rates_used.USD, 7_200_000);
  assert.equal(s.rates_used.EUR, 7_820_000);
});

test('computeStats 折算：缺汇率表 → 外币 fallback=1（视同 CNY 分），rates_used 仍留痕 fallback', () => {
  const contracts = [{ ...mk('b', '2026-10-02', 100, 'active'), currency: 'USD' }];
  const s = computeStats(contracts, NOW, { rates: undefined });
  assert.equal(s.total_cents, 100); // 未折算，按 CNY 分计
  assert.equal(s.rates_used.USD, 1); // fallback=1 留痕
});

test('computeStats 折算：纯 CNY 库 rates_used 为空对象', () => {
  const contracts = [mk('a', '2026-10-01', 50, 'active')];
  const s = computeStats(contracts, NOW, { rates: RATES });
  assert.deepEqual(s.rates_used, {});
  assert.equal(s.total_cents, 50);
});

test('computeStats 折算：rateFor 对缺币种/非整数 rate 拒用 → fallback=1，不崩', () => {
  const contracts = [{ ...mk('b', '2026-10-02', 100, 'active'), currency: 'JPY' }];
  const s = computeStats(contracts, NOW, { rates: RATES });
  assert.equal(s.rates_used.JPY, 1);
  assert.equal(s.total_cents, 100);
});

// ── computeUpcoming ────────────────────────────────────────────

function isoDaysFrom(daysLeft) {
  const t = Date.UTC(2026, 8, 10) + daysLeft * 86400000; // base = NOW 的 UTC 日
  return new Date(t).toISOString().slice(0, 10);
}

test('US-S2-①③ 即将到期：0/30 入、31 出、负排除、仅 active、按 end_date 升序', () => {
  const contracts = [
    { id: 'in0', status: 'active', end_date: isoDaysFrom(0) },
    { id: 'in10', status: 'active', end_date: isoDaysFrom(10) },
    { id: 'in30', status: 'active', end_date: isoDaysFrom(30) },
    { id: 'out31', status: 'active', end_date: isoDaysFrom(31) },
    { id: 'neg', status: 'active', end_date: isoDaysFrom(-1) },
    { id: 'draft', status: 'draft', end_date: isoDaysFrom(5) },
    { id: 'arch', status: 'archived', end_date: isoDaysFrom(5) },
  ];
  const up = computeUpcoming(contracts, NOW);
  assert.deepEqual(up.map((x) => x.id), ['in0', 'in10', 'in30']);
  assert.deepEqual(up.map((x) => x.days_left), [0, 10, 30]);
});

test('US-S2 即将到期：horizonDays 可注入', () => {
  const contracts = [
    { id: 'd2', status: 'active', end_date: isoDaysFrom(2) },
    { id: 'd5', status: 'active', end_date: isoDaysFrom(5) },
  ];
  const up = computeUpcoming(contracts, NOW, { horizonDays: 4 });
  assert.deepEqual(up.map((x) => x.id), ['d2']); // d5 days_left=5 > 4 → 出
});

// ── computeOverdueChains ───────────────────────────────────────

function isoDaysAgo(days) {
  return new Date(NOW.getTime() - days * 86400000).toISOString();
}
function chain(id, cid, submitter, { created = isoDaysAgo(0), decidedDaysAgo = null, status = 'pending' } = {}) {
  const steps =
    decidedDaysAgo === null
      ? [{ level: 1, role: 'admin', outcome: null, approver_id: null, comment: null, decided_at: null }]
      : [
          { level: 1, role: 'admin', outcome: 'approved', approver_id: 'a1', comment: 'ok', decided_at: isoDaysAgo(decidedDaysAgo) },
          { level: 2, role: 'legal', outcome: null, approver_id: null, comment: null, decided_at: null },
        ];
  return { id, contract_id: cid, submitter_id: submitter, status, steps, created_at: created };
}
const contractRows = [
  { id: 'k1', title: '合同k1' },
  { id: 'k3', title: '合同k3' },
  { id: 'k7', title: '合同k7' },
];

test('US-S2-②③④ 超时：wait===slaDays 不入 / slaDays+1 入；首步 from created_at、二级链第二步 from 首步 decided_at；approved/rejected 不入；waited_days ceil', () => {
  const chains = [
    chain('c1', 'k1', 'u1', { created: isoDaysAgo(8) }),            // 首步 created 8 天前 → wait 8 → 入
    chain('c2', 'k1', 'u2', { created: isoDaysAgo(7) }),            // wait 7 == slaDays → 不入
    chain('c3', 'k3', 'u3', { created: isoDaysAgo(20), decidedDaysAgo: 8 }), // 二级链第二步自首步 decided_at 起 wait 8 → 入（非 created 20）
    chain('c4', 'k3', 'u4', { created: isoDaysAgo(5), decidedDaysAgo: 3 }), // 第二步 wait 3 → 不入
    chain('c7', 'k7', 'u7', { created: isoDaysAgo(7.5) }),          // wait 7.5 → ceil 8 → 入
    chain('c5', 'k1', 'u5', { created: isoDaysAgo(8), status: 'approved' }), // approved → 不入
    chain('c6', 'k1', 'u6', { created: isoDaysAgo(8), status: 'rejected' }), // rejected → 不入
  ];
  const out = computeOverdueChains(chains, contractRows, NOW);
  const byId = Object.fromEntries(out.map((x) => [x.chain_id, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['c1', 'c3', 'c7']);
  assert.deepEqual(byId.c1, { chain_id: 'c1', contract_id: 'k1', title: '合同k1', submitter_id: 'u1', level: 1, role: 'admin', waited_days: 8 });
  assert.deepEqual(byId.c3, { chain_id: 'c3', contract_id: 'k3', title: '合同k3', submitter_id: 'u3', level: 2, role: 'legal', waited_days: 8 });
  assert.equal(byId.c7.waited_days, 8);
});

test('US-S2-④ 确定性：now 注入 → 两次调用结果一致', () => {
  const chains = [chain('cx', 'k1', 'ux', { created: isoDaysAgo(9) })];
  assert.deepEqual(computeOverdueChains(chains, contractRows, NOW), computeOverdueChains(chains, contractRows, NOW));
});