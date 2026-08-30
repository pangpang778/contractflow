// test/report.test.js — 中文管理周报渲染（S2，pure）。千分位 / 表格转义 / 各分节 / 空数据不崩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, formatYuan } from '../shared/report.js';

const NOW = new Date('2026-09-10T12:00:00Z');
const ZERO = { draft: 0, in_review: 0, pending_sign: 0, active: 0, archived: 0, void: 0, expired: 0 };

test('US-S3-③ 千分位：整数分 → 千分位元字符串，恒 2 位小数', () => {
  assert.equal(formatYuan(0), '0.00');
  assert.equal(formatYuan(5), '0.05');
  assert.equal(formatYuan(123), '1.23');
  assert.equal(formatYuan(123456), '1,234.56'); // 验收场景
  assert.equal(formatYuan(1000000), '10,000.00');
  assert.equal(formatYuan(1234567), '12,345.67');
  assert.equal(formatYuan(12000005), '120,000.05');
  assert.equal(formatYuan(1234567890), '12,345,678.90');
});

const stats = {
  currency: 'CNY',
  total_cents: 123456,
  by_status: { draft: 1, in_review: 0, pending_sign: 0, active: 1, archived: 0, void: 0, expired: 0 },
  by_status_cents: { draft: 123456, in_review: 0, pending_sign: 0, active: 0, archived: 0, void: 0, expired: 0 },
  ending_this_month: [],
};

// 即将到期按 end_date 升序应渲染为 u3(09-12) → u1(09-20) → u2(09-25)。
const upcoming = [
  { id: 'u1', title: '采购|合同', counterparty_id: 'cp_1', amount: 50000, status: 'active', end_date: '2026-09-20', days_left: 10 },
  { id: 'u2', title: '服务合同\n（续签）', counterparty_id: 'cp_2', amount: 70000, status: 'active', end_date: '2026-09-25', days_left: 15 },
  { id: 'u3', title: '含\\n换行串', counterparty_id: 'cp_3', amount: 123456, status: 'active', end_date: '2026-09-12', days_left: 2 },
];

const overdue = [
  { chain_id: 'ap1', contract_id: 'k1', title: '合同k1', submitter_id: 'u1', level: 1, role: 'admin', waited_days: 8 },
  { chain_id: 'ap2', contract_id: 'k2', title: '合同k2', submitter_id: 'u2', level: 2, role: 'legal', waited_days: 9 },
];

test('US-S3-① 标题 + 生成日期（中文）', () => {
  const md = renderReport({ generated_at: NOW, stats, upcoming, overdue });
  assert.equal(typeof md, 'string');
  assert.ok(md.startsWith('# '), '首行应为标题');
  assert.match(md, /生成日期：2026年9月10日/);
});

test('US-S3-② 统计表：含表头、全部状态行、合计行', () => {
  const md = renderReport({ generated_at: NOW, stats, upcoming: [], overdue: [] });
  assert.ok(md.includes('| 状态 | 合同数 | 金额（元） |'), '统计表头缺失');
  for (const s of Object.keys(ZERO)) assert.ok(md.includes(`| ${s} `), `缺少状态行 ${s}`);
  const totalLine = md.split('\n').find((l) => l.includes('合计'));
  assert.match(totalLine, /\| 2 \| 1,234\.56 \|/, '合计行 = 2 合同 / 1,234.56 元');
});

test('US-S3-⑤ 即将到期明细：按 end_date 升序 + 列齐全 + 元金额', () => {
  const md = renderReport({ generated_at: NOW, stats, upcoming, overdue: [] });
  assert.ok(md.includes('| 标题 | 相对方 | 金额（元） | 到期日 | 剩余天数 |'), '即将到期表头缺失');
  const i3 = md.indexOf('含 换行串'); // u3（09-12）
  const i1 = md.indexOf('采购\\|合同'); // u1（09-20）
  const i2 = md.indexOf('服务合同 （续签）'); // u2（09-25）
  assert.ok(i3 > -1 && i1 > -1 && i2 > -1, '三行均在');
  assert.ok(i3 < i1 && i1 < i2, '应按 end_date 升序');
  assert.ok(md.includes('2026-09-20') && md.includes('500.00'), '含到期日与千分位元金额');
});

test('US-S3-④ 表格转义：标题含 | / 换行 / 字面 \\n 不破表', () => {
  const md = renderReport({ generated_at: NOW, stats, upcoming, overdue: [] });
  assert.ok(md.includes('采购\\|合同'), '| 应转义为 \\|');
  assert.ok(!md.includes('采购\n'), '不得出现破表换行');
  assert.ok(md.includes('服务合同 （续签）'), '换行符应转为空格');
  assert.ok(md.includes('含 换行串'), '字面 \\n 应转为空格');
});

test('US-S3-⑥ 超时清单：六字段行齐全', () => {
  const md = renderReport({ generated_at: NOW, stats, upcoming: [], overdue });
  assert.ok(md.includes('| 审批链 | 合同 | 提交人 | 当前步骤 | 等待天数 |'), '超时表头缺失');
  assert.ok(md.includes('ap1') && md.includes('合同k1') && md.includes('u1'));
  assert.ok(md.includes('L1 admin') && md.includes('L2 legal'), '当前步骤为 L{level} {role}');
  assert.ok(md.includes('ap2') && md.includes('9'), '等待天数列');
});

test('US-S3-⑦ 超时为空的友好提示：出现"无"，且无空超时表', () => {
  const md = renderReport({ generated_at: NOW, stats, upcoming: [], overdue: [] });
  assert.ok(md.includes('无'), '空超时应给友好提示');
  assert.ok(!md.includes('| 审批链 |'), '不得渲染空表');
});

test('US-S3-⑦ 空数据（全零 stats / 空 upcoming / 空 overdue）不崩、输出合法字符串', () => {
  const emptyStats = { currency: 'CNY', total_cents: 0, by_status: ZERO, by_status_cents: ZERO, ending_this_month: [] };
  let out;
  assert.doesNotThrow(() => {
    out = renderReport({ generated_at: NOW, stats: emptyStats, upcoming: [], overdue: [] });
  });
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('0.00'), '合计应为 0.00');
});