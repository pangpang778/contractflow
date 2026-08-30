import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAmendment, validateAmendment, transition, applyAmendment,
  AMENDMENT_STATUSES, AMENDMENT_TERMINAL,
} from '../shared/amendments.js';

// 已生效父合同（apply 前置）：无 version（视为 v1）、非 superseded、active。
const PARENT = {
  id: 'c_1', title: '原合同', counterparty_id: 'cp_1', amount: 1500000, currency: 'CNY',
  start_date: '2026-09-01', end_date: '2027-09-01', description: '',
  status: 'active', created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};
const VALID = {
  parent_contract_id: 'c_1',
  reason: '物价上涨调整金额',
  changes: { amount: 2000000 },
};
const NOW = '2026-09-02T00:00:00.000Z';

test('状态集为 spec 生命周期、终态 applied/rejected', () => {
  assert.deepEqual(AMENDMENT_STATUSES, ['draft', 'in_review', 'approved', 'applied', 'rejected']);
  assert.deepEqual(AMENDMENT_TERMINAL, new Set(['applied', 'rejected']));
});

test('合法输入创建变更单，ID am_ 前缀、初始 draft、引用父合同', () => {
  const a = createAmendment(VALID, { now: NOW });
  assert.match(a.id, /^am_\d+-\w+$/);
  assert.equal(a.status, 'draft');
  assert.equal(a.parent_contract_id, 'c_1');
  assert.equal(a.reason, '物价上涨调整金额');
  assert.deepEqual(a.changes, { amount: 2000000 });
  assert.equal(a.created_at, NOW);
});

test('校验矩阵：缺 reason/缺父合同/changes 空/含非冻结键/金额浮点或负拒绝', () => {
  assert.equal(validateAmendment({ ...VALID, reason: '' }).ok, false);
  assert.equal(validateAmendment({ ...VALID, parent_contract_id: '' }).ok, false);
  assert.equal(validateAmendment({ ...VALID, changes: {} }).ok, false);
  assert.equal(validateAmendment({ ...VALID, changes: { junk: 1 } }).ok, false);
  assert.equal(validateAmendment({ ...VALID, changes: { amount: 2000.5 } }).ok, false);
  assert.equal(validateAmendment({ ...VALID, changes: { amount: -1 } }).ok, false);
  assert.equal(validateAmendment({ ...VALID, changes: { currency: 'USD' } }).ok, false);
  assert.equal(validateAmendment(VALID).ok, true);
});

test('提交 draft→in_review（editor）成功并记提交人', () => {
  const a = createAmendment(VALID, { now: NOW });
  const next = transition(a, 'in_review', { role: 'editor', id: 'u_1' }, { now: NOW });
  assert.equal(next.status, 'in_review');
  assert.equal(next.submitter_id, 'u_1');
  assert.notEqual(next, a);
  assert.equal(a.status, 'draft');
});

test('非法角色/非法跳转：viewer 提交拒、editor 批准拒、draft→approved 拒', () => {
  const a = createAmendment(VALID, { now: NOW });
  assert.throws(() => transition(a, 'in_review', { role: 'viewer', id: 'u2' }), { code: 'FORBIDDEN' });
  assert.throws(() => transition(a, 'approved', { role: 'editor', id: 'u2' }), { code: 'ILLEGAL_TRANSITION' });
});

test('提交人自审拒绝（admin 批准自己的变更单）', () => {
  const a = createAmendment(VALID, { now: NOW });
  const submitted = transition(a, 'in_review', { role: 'admin', id: 'u_admin' });
  assert.throws(() => transition(submitted, 'approved', { role: 'admin', id: 'u_admin', }, { comment: 'ok' }), { code: 'FORBIDDEN' });
});

test('批准需 admin 且意见必填', () => {
  const a = createAmendment(VALID, { now: NOW });
  const submitted = transition(a, 'in_review', { role: 'editor', id: 'u1' });
  assert.throws(() => transition(submitted, 'approved', { role: 'editor', id: 'u2' }, { comment: 'ok' }), { code: 'FORBIDDEN' });
  assert.throws(() => transition(submitted, 'approved', { role: 'admin', id: 'u2' }, { comment: '  ' }), { code: 'INVALID' });
  const app = transition(submitted, 'approved', { role: 'admin', id: 'u2' }, { comment: '同意' });
  assert.equal(app.status, 'approved');
  assert.equal(app.approver_id, 'u2');
  assert.equal(app.decision_comment, '同意');
});

test('驳回 in_review→rejected（admin）；终态无出边（rejected 不可再提交）', () => {
  const a = createAmendment(VALID, { now: NOW });
  const submitted = transition(a, 'in_review', { role: 'editor', id: 'u1' });
  const rej = transition(submitted, 'rejected', { role: 'admin', id: 'u2' }, { comment: '资料不齐' });
  assert.equal(rej.status, 'rejected');
  assert.throws(() => transition(rej, 'in_review', { role: 'editor', id: 'u1' }), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => transition(rej, 'approved', { role: 'admin', id: 'u2' }, { comment: 'x' }), { code: 'ILLEGAL_TRANSITION' });
});

test('applied 只能经 applyAmendment 达成（通用迁移拒）', () => {
  const a = createAmendment(VALID, { now: NOW });
  assert.throws(() => transition(a, 'applied', { role: 'admin', id: 'u2' }), { code: 'ILLEGAL_TRANSITION' });
});

test('apply 前置：非 approved / 父非 active / 父 superseded 均拒', () => {
  const draft = createAmendment(VALID, { now: NOW });
  assert.throws(() => applyAmendment(draft, PARENT, { now: NOW }), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => applyAmendment({ ...draft, status: 'approved' }, null, { now: NOW }), { code: 'NOT_FOUND' });
  assert.throws(() => applyAmendment({ ...draft, status: 'approved' }, { ...PARENT, status: 'pending_sign' }, { now: NOW }), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => applyAmendment({ ...draft, status: 'approved' }, { ...PARENT, superseded: true }, { now: NOW }), { code: 'ILLEGAL_TRANSITION' });
});

test('apply 版本继承：父无 version → 继任 v2，父标 superseded 指针，未声明字段继承', () => {
  const approved = { ...(createAmendment(VALID, { now: NOW })), status: 'approved' };
  const { superseded, next, amendment } = applyAmendment(approved, PARENT, { now: NOW });
  // 继任
  assert.equal(next.status, 'active');
  assert.equal(next.version, 2);
  assert.equal(next.parent_contract_id, 'c_1');
  assert.match(next.id, /^c_\d+-\w+$/);
  assert.equal(next.amount, 2000000); // changes 覆盖
  assert.equal(next.end_date, '2027-09-01'); // 未声明字段继承
  assert.equal(next.title, '原合同');
  assert.equal(next.counterparty_id, 'cp_1');
  assert.equal(next.currency, 'CNY');
  assert.equal(next.start_date, '2026-09-01');
  // 父标 superseded
  assert.equal(superseded.superseded, true);
  assert.equal(superseded.superseded_by, next.id);
  assert.equal(superseded.superseded_at, NOW);
  // 变更单落 applied
  assert.equal(amendment.status, 'applied');
  assert.equal(amendment.resulting_contract_id, next.id);
});

test('apply 版本链递增：父 version=5 → 继任 v6；金额保持整数分', () => {
  const parentV5 = { ...PARENT, version: 5 };
  const approved = { ...(createAmendment(VALID, { now: NOW })), status: 'approved' };
  const { next } = applyAmendment(approved, parentV5, { now: NOW });
  assert.equal(next.version, 6);
  assert.ok(Number.isInteger(next.amount));
});

test('apply 不可变：父合同与变更单入参不被 mutate', () => {
  const parentBefore = { ...PARENT };
  const amd = { ...(createAmendment(VALID, { now: NOW })), status: 'approved' };
  const { superseded } = applyAmendment(amd, PARENT, { now: NOW });
  assert.equal(PARENT.superseded, undefined); // 原对象未被标
  assert.equal(parentBefore.superseded_by, undefined);
  assert.equal(amd.status, 'approved'); // 原变更单未变
  assert.notEqual(superseded, PARENT);
});