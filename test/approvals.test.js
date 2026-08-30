// test/approvals.test.js — 审批链领域纯函数（seam S1，T1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContract } from '../shared/contracts.js';
import {
  TWO_LEVEL_THRESHOLD_CENTS,
  chainStepsForAmount,
  openChain,
  currentStep,
  isChainComplete,
  resolveStep,
  resolveContractStatus,
} from '../shared/approvals.js';

const SUB = { role: 'editor', id: 'u_1' };
const ADMIN = { role: 'admin', id: 'u_2' };
const LEGAL = { role: 'legal', id: 'u_3' };

test('金额分级边界：阈值下 1 级，临界与之上 2 级', () => {
  assert.equal(TWO_LEVEL_THRESHOLD_CENTS, 10_000_000);
  assert.deepEqual(chainStepsForAmount(TWO_LEVEL_THRESHOLD_CENTS - 1), [{ level: 1, role: 'admin' }]);
  assert.deepEqual(chainStepsForAmount(TWO_LEVEL_THRESHOLD_CENTS), [
    { level: 1, role: 'admin' },
    { level: 2, role: 'legal' },
  ]);
  assert.deepEqual(chainStepsForAmount(TWO_LEVEL_THRESHOLD_CENTS + 1), [
    { level: 1, role: 'admin' },
    { level: 2, role: 'legal' },
  ]);
});

test('openChain 建档：pending、留痕步为待决、金额快照、提交人记录', () => {
  const c = createContract({ ...BASE, amount: 15_000_000 });
  const ch = openChain({ contractId: c.id, amount: c.amount, submitterId: SUB.id, now: '2026-08-30T00:00:00.000Z' });
  assert.equal(ch.status, 'pending');
  assert.equal(ch.contract_id, c.id);
  assert.equal(ch.amount, 15_000_000);
  assert.equal(ch.submitter_id, SUB.id);
  assert.match(ch.id, /^ap_/);
  assert.equal(ch.created_at, '2026-08-30T00:00:00.000Z');
  assert.equal(currentStep(ch).level, 1);
  for (const s of ch.steps) {
    assert.equal(s.outcome, null);
    assert.equal(s.approver_id, null);
    assert.equal(s.decided_at, null);
  }
});

test('resolveStep：单级链 admin 通过即完整 → approved', () => {
  const ch = openChain({ contractId: 'c_1', amount: 1, submitterId: SUB.id });
  const next = resolveStep(ch, ADMIN, 'approved', '意见', '2026-08-30T10:00:00.000Z');
  assert.equal(next.status, 'approved');
  assert.equal(isChainComplete(next), true);
  const step = next.steps[0];
  assert.equal(step.outcome, 'approved');
  assert.equal(step.approver_id, ADMIN.id);
  assert.equal(step.comment, '意见');
  assert.equal(step.decided_at, '2026-08-30T10:00:00.000Z');
});

test('resolveStep：二级链必须按序 admin→legal', () => {
  const ch = openChain({ contractId: 'c_1', amount: 20_000_000, submitterId: SUB.id });
  // L1 通过后链仍 pending（L2 未决）
  const l1 = resolveStep(ch, ADMIN, 'approved', 'ok');
  assert.equal(l1.status, 'pending');
  assert.equal(isChainComplete(l1), false);
  assert.equal(currentStep(l1).level, 2);
  // legal 复核 L2 → 完整
  const l2 = resolveStep(l1, LEGAL, 'approved', '复核无误');
  assert.equal(l2.status, 'approved');
  assert.equal(isChainComplete(l2), true);
});

// 审批只作用于当前步骤：L1（admin）未决时对链动作即当前角色不匹配 → FORBIDDEN（US-A3③ 归并到 ④）。
test('resolveStep：非当前步骤角色对链动作 → FORBIDDEN', () => {
  const ch = openChain({ contractId: 'c_1', amount: 20_000_000, submitterId: SUB.id });
  assert.throws(() => resolveStep(ch, LEGAL, 'approved', 'x'), { code: 'FORBIDDEN' });
});

test('resolveStep：步骤角色不匹配 → FORBIDDEN（editor 冒充 admin / admin 复核 legal 步骤）', () => {
  const ch1 = openChain({ contractId: 'c_1', amount: 1, submitterId: SUB.id });
  assert.throws(() => resolveStep(ch1, { role: 'editor', id: 'u_9' }, 'approved', 'x'), { code: 'FORBIDDEN' });
  const ch2 = openChain({ contractId: 'c_1', amount: 20_000_000, submitterId: SUB.id });
  const l1 = resolveStep(ch2, ADMIN, 'approved', 'ok');
  // admin 无资格复核 legal 步骤
  assert.throws(() => resolveStep(l1, ADMIN, 'approved', 'x'), { code: 'FORBIDDEN' });
});

test('resolveStep：提交人不能审批自己 → FORBIDDEN', () => {
  const ch = openChain({ contractId: 'c_1', amount: 1, submitterId: ADMIN.id }); // admin 自己提交
  assert.throws(() => resolveStep(ch, ADMIN, 'approved', 'x'), { code: 'FORBIDDEN' });
});

test('resolveStep：意见必填 → INVALID', () => {
  const ch = openChain({ contractId: 'c_1', amount: 1, submitterId: SUB.id });
  assert.throws(() => resolveStep(ch, ADMIN, 'approved', ''), { code: 'INVALID' });
});

test('resolveStep：reject 即链 rejected（不再推进）', () => {
  const ch = openChain({ contractId: 'c_1', amount: 20_000_000, submitterId: SUB.id });
  const r = resolveStep(ch, ADMIN, 'rejected', '金额过高');
  assert.equal(r.status, 'rejected');
  assert.equal(r.steps[0].outcome, 'rejected');
  assert.equal(r.steps[0].comment, '金额过高');
});

const BASE = {
  title: '市集货架采购', counterparty_id: 'cp_1', amount: 1500000, start_date: '2026-09-01', end_date: '2027-09-01',
};

test('resolveContractStatus：链完成/驳回时翻转合同状态（复用状态机边校验）', () => {
  const c = createContract(BASE);
  const inReview = resolveContractStatus(c, 'in_review');
  assert.equal(inReview.status, 'in_review');
  const pending = resolveContractStatus(inReview, 'pending_sign');
  assert.equal(pending.status, 'pending_sign');
  const rejected = resolveContractStatus(inReview, 'draft');
  assert.equal(rejected.status, 'draft');
  // 非法边仍被状态机拒绝（不绕过）
  assert.throws(() => resolveContractStatus(c, 'active'), { code: 'ILLEGAL_TRANSITION' });
});