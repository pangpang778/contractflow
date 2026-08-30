// test/reminders.test.js — 到期提醒扫描器（S1，pure）：三档触发/过期/无到期日/去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDueReminders, REMINDER_TIERS } from '../shared/reminders.js';

test('REMINDER_TIERS = [30, 7, 1]', () => {
  assert.deepEqual(REMINDER_TIERS, [30, 7, 1]);
});

// 以固定 "now" 建合同；end_date 相对 now 偏移天数。
function contract(id, daysToEnd, { status = 'active', end_date = isoDaysFrom(daysToEnd) } = {}) {
  return { id, status, title: `合同${id}`, end_date };
}
// 距离 now 之后 N 天的 YYYY-MM-DD（UTC）
function isoDaysFrom(daysLeft) {
  const t = new Date(Date.UTC(2026, 8, 10)); // 2026-09-10
  const d = new Date(t.getTime() + daysLeft * 86400000);
  return d.toISOString().slice(0, 10);
}
const NOW = new Date('2026-09-10T12:00:00Z');

function keys(rs) {
  return rs.map((r) => `${r.contract_id}:${r.tier}`).sort();
}

test('US-E1-① 40 天外不产；30 天窗触发 30 档；22 天只触发 30', () => {
  const far = computeDueReminders([contract('c1', 400)], NOW);
  assert.deepEqual(far, []);
  const c22 = computeDueReminders([contract('c2', 22)], NOW);
  assert.deepEqual(keys(c22), ['c2:30']);
  assert.equal(c22[0].days_left, 22);
});

test('US-E1-① 7 天窗触发 7 档（30 已发不重发）；当天到期触发 1 档', () => {
  const c5 = computeDueReminders([contract('c3', 5)], NOW);
  assert.deepEqual(keys(c5), ['c3:7']);
  const d0 = computeDueReminders([contract('c4', 0)], NOW);
  assert.deepEqual(keys(d0), ['c4:1']);
});

test('边界整点：30 恰好 → 30；7 恰好 → 7；1 恰好 → 1', () => {
  assert.deepEqual(keys(computeDueReminders([contract('a', 30)], NOW)), ['a:30']);
  assert.deepEqual(keys(computeDueReminders([contract('b', 7)], NOW)), ['b:7']);
  assert.deepEqual(keys(computeDueReminders([contract('c', 1)], NOW)), ['c:1']);
});

test('US-E1-② 已过期不产；无到期日跳过不崩', () => {
  assert.deepEqual(computeDueReminders([contract('e1', -1)], NOW), []);
  const missing = { id: 'e2', status: 'active', title: '无到期', end_date: undefined };
  assert.deepEqual(computeDueReminders([missing], NOW), []);
});

test('US-E1-④ 非 active 态不产提醒', () => {
  const cases = ['draft', 'in_review', 'pending_sign', 'archived', 'void', 'expired'];
  for (const status of cases) {
    assert.deepEqual(computeDueReminders([contract('x', 3, { status })], NOW), [], `status=${status}`);
  }
});

test('US-E1-③ 去重：alreadySent 含某档 → 该档不发，其余档照发', () => {
  // 合同 c30 在 [7,30] 窗：30 档已发 → 跳过；合同 c7 在 [1,7]窗无冲突照发
  const rs = computeDueReminders([contract('c30', 22), contract('c7', 5)], NOW, new Set(['c30:30']));
  assert.deepEqual(keys(rs), ['c7:7']);
  // 同合同多档已发则全跳过
  const both = computeDueReminders([contract('c2', 22)], NOW, new Set(['c2:30']));
  assert.deepEqual(both, []);
});

test('US-E1-⑤ 结构齐全：contract_id/tier/due_date/days_left/sent_key', () => {
  const rs = computeDueReminders([contract('c9', 22)], NOW, new Set());
  assert.equal(rs.length, 1);
  const r = rs[0];
  assert.equal(r.contract_id, 'c9');
  assert.equal(r.tier, 30);
  assert.equal(r.due_date, isoDaysFrom(22));
  assert.equal(r.days_left, 22);
  assert.equal(r.sent_key, 'c9:30');
});