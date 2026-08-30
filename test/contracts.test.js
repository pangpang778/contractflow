import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContract, validateContract, applyUpdate, transition, STATES,
} from '../shared/contracts.js';

const VALID = {
  title: '市集货架采购',
  counterparty_id: 'cp_1',
  amount: 1500000,
  currency: 'CNY',
  start_date: '2026-09-01',
  end_date: '2027-09-01',
};

test('状态全集为 spec 生命周期的 MVP 集', () => {
  assert.deepEqual(
    new Set(STATES),
    new Set(['draft', 'in_review', 'pending_sign', 'active', 'archived', 'void', 'expired']),
  );
});

test('合法输入创建 draft 合同，ID 合规', () => {
  const c = createContract(VALID, { now: '2026-08-30T00:00:00.000Z' });
  assert.equal(c.status, 'draft');
  assert.match(c.id, /^c_\d+-\w+$/);
  assert.equal(c.amount, 1500000);
  assert.equal(c.created_at, '2026-08-30T00:00:00.000Z');
  assert.equal(c.updated_at, c.created_at);
});

test('必填缺失拒绝', () => {
  for (const k of ['title', 'counterparty_id', 'amount', 'start_date', 'end_date']) {
    const p = { ...VALID };
    delete p[k];
    assert.equal(validateContract(p).ok, false, `field=${k}`);
  }
});

test('金额：浮点/负数拒绝，0 允许，非整分拒绝', () => {
  assert.equal(validateContract({ ...VALID, amount: 1500.5 }).ok, false);
  assert.equal(validateContract({ ...VALID, amount: -1 }).ok, false);
  assert.equal(validateContract({ ...VALID, amount: 0 }).ok, true);
  assert.equal(validateContract({ ...VALID, amount: 1500000 }).ok, true);
});

test('日期：非 YYYY-MM-DD 或 end<start 拒绝', () => {
  assert.equal(validateContract({ ...VALID, end_date: '2026/9/1' }).ok, false);
  assert.equal(validateContract({ ...VALID, end_date: '2025-09-01' }).ok, false);
});

test('币种：USD/EUR 放行、未知拒绝、缺省默认 CNY', () => {
  assert.equal(validateContract({ ...VALID, currency: 'USD' }).ok, true);
  assert.equal(validateContract({ ...VALID, currency: 'EUR' }).ok, true);
  assert.equal(validateContract({ ...VALID, currency: 'XXX' }).ok, false);
  assert.equal(validateContract(VALID).ok, true);
  assert.equal(createContract({ ...VALID, currency: 'USD' }).currency, 'USD');
  assert.equal(createContract(VALID).currency, 'CNY');
});

test('迁移合法边 draft→in_review 不可变', () => {
  const c = createContract(VALID);
  const next = transition(c, 'in_review', 'editor');
  assert.equal(next.status, 'in_review');
  assert.notEqual(next, c);
  assert.equal(c.status, 'draft');
});

test('非法跳转 draft→active 拒绝且原对象不变', () => {
  const c = createContract(VALID);
  assert.throws(() => transition(c, 'active', 'admin'));
  assert.equal(c.status, 'draft');
});

test('终态无出边：active→archived 后不可再迁', () => {
  const a = chainTo('active', 'admin');
  const archived = transition(a, 'archived', 'admin');
  assert.equal(archived.status, 'archived');
  assert.throws(() => transition(archived, 'active', 'admin'));
});

test('越权迁移：editor 不可审批 in_review→pending_sign', () => {
  const c = chainTo('in_review', 'editor');
  assert.throws(() => transition(c, 'pending_sign', 'editor'));
  assert.equal(transition(c, 'pending_sign', 'admin').status, 'pending_sign');
});

test('作废/到期 admin-only', () => {
  const a = chainTo('active', 'admin');
  assert.throws(() => transition(a, 'void', 'editor'));
  assert.equal(transition(a, 'void', 'admin').status, 'void');
  assert.throws(() => transition(a, 'expired', 'editor'));
  assert.equal(transition(a, 'expired', 'admin').status, 'expired');
});

test('active 后冻结字段更新被拒；patch 中 status 被忽略', () => {
  const a = chainTo('active', 'admin');
  assert.throws(() => applyUpdate(a, { amount: 2000000 }));
  assert.throws(() => applyUpdate(a, { title: '改名' }));
  const equivalentStatus = applyUpdate({ ...a }, { status: 'expired' });
  assert.equal(equivalentStatus.status, 'active');
});

test('终态仍冻结主体字段：archived/void/expired 不可改金额', () => {
  for (const terminal of ['archived', 'void', 'expired']) {
    const t = transition(chainTo('active', 'admin'), terminal, 'admin');
    assert.throws(() => applyUpdate(t, { amount: 999 }), /冻结字段 amount/, terminal);
  }
});

test('patch 不能伪造 id/status/created_at/updated_at（白名单）', () => {
  const c = createContract(VALID, { now: '2026-08-30T00:00:00.000Z' });
  const forged = applyUpdate(c, { id: 'c_evil', created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(forged.id, c.id);
  assert.equal(forged.created_at, c.created_at);
});

test('未知字段注入拒绝（INVALID）', () => {
  const c = createContract(VALID);
  assert.throws(() => applyUpdate(c, { junk: true }));
});

test('未冻结时 applyUpdate 返回新对象，不可变', () => {
  const c = createContract(VALID);
  const edited = applyUpdate(c, { description: '补充说明' });
  assert.equal(edited.description, '补充说明');
  assert.notEqual(edited, c);
  assert.equal(c.description, undefined);
  assert.ok(edited.updated_at >= c.updated_at);
});

test('金额运算保持整数分（无浮点副作用）', () => {
  const c = createContract(VALID);
  assert.ok(Number.isInteger(c.amount));
  const renamed = applyUpdate(c, { description: 'x' });
  assert.ok(Number.isInteger(renamed.amount));
});

// helper：沿合法链走到某状态
function chainTo(target, role) {
  let c = createContract(VALID);
  const path = {
    in_review: ['in_review'],
    pending_sign: ['in_review', 'pending_sign'],
    active: ['in_review', 'pending_sign', 'active'],
  }[target];
  for (const s of path) c = transition(c, s, role);
  return c;
}