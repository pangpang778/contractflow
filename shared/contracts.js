// shared/contracts.js — 合同领域层：纯函数，不透传 http/store。
// 状态机矩阵、金额整数语义、冻结规则为单一事实源，server 与测试共用。

import { newId } from './ids.js';

export const STATES = ['draft', 'in_review', 'pending_sign', 'active', 'archived', 'void', 'expired'];
export const TERMINAL = new Set(['archived', 'void', 'expired']);
export const CURRENCY = 'CNY';

// active 后（及终态）只读的业务主体字段（冻结）——金额/币种/期限/相对方/标题。
export const BUSINESS_FIELDS = ['title', 'amount', 'currency', 'counterparty_id', 'start_date', 'end_date'];
export const FROZEN_FIELDS = BUSINESS_FIELDS; // 别名，语意：生效后不可改的字段
const ALWAYS_EDITABLE = ['description']; // 备注永不冻结
const IMMUTABLE = new Set(['id', 'status', 'created_at', 'updated_at']); // 不可被 patch 伪造

// 是否冻结：已生效（active）或已归档/作废/到期（终态）一律冻结主体字段。
export function isFrozen(status) {
  return status === 'active' || TERMINAL.has(status);
}

// 迁移边 + 各边所需角色（白名单先于一切）。空对象 = 该状态无出边（终态）。
export const TRANSITIONS = {
  draft: { to: { in_review: ['admin', 'editor'], void: ['admin'] } },
  in_review: { to: { draft: ['admin', 'editor'], pending_sign: ['admin'], void: ['admin'] } },
  pending_sign: { to: { active: ['admin', 'editor'], void: ['admin'] } },
  active: { to: { archived: ['admin', 'editor'], void: ['admin'], expired: ['admin'] } },
  archived: { to: {} },
  void: { to: {} },
  expired: { to: {} },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

export function validateContract(input) {
  const errors = [];
  for (const k of ['title', 'counterparty_id', 'amount', 'start_date', 'end_date']) {
    if (input[k] === undefined || input[k] === null || input[k] === '') errors.push(`缺失必填字段: ${k}`);
  }
  if (typeof input.title === 'string' && input.title.trim() === '') errors.push('标题不能为空');
  const a = input.amount;
  if (a !== undefined && (!Number.isInteger(a) || a < 0)) errors.push('金额必须为非负整数（单位：分）');
  if (input.currency !== undefined && input.currency !== CURRENCY) errors.push(`币种必须为 ${CURRENCY}`);
  if (input.start_date !== undefined && !isValidDate(input.start_date)) errors.push('开始日期须为 YYYY-MM-DD');
  if (input.end_date !== undefined && !isValidDate(input.end_date)) errors.push('结束日期须为 YYYY-MM-DD');
  if (isValidDate(input.start_date) && isValidDate(input.end_date) && input.end_date < input.start_date) {
    errors.push('结束日期不得早于开始日期');
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export function createContract(input, { id, now = new Date().toISOString() } = {}) {
  const v = validateContract(input);
  if (!v.ok) {
    const e = new Error(v.errors.join('; '));
    e.code = 'INVALID';
    throw e;
  }
  return {
    id: id ?? newId('c'),
    title: input.title,
    counterparty_id: input.counterparty_id,
    amount: input.amount,
    currency: CURRENCY,
    start_date: input.start_date,
    end_date: input.end_date,
    description: input.description,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
}

// 不可变更新。白名单逐键放行：
//  - id/status/created_at/updated_at 永不可被 patch 伪造（忽略）；
//  - 冻结态（active/终态）只许改 description，改业务主体字段抛 FROZEN；
//  - 未冻结态可改业务主体字段与 description，其余未知键一律 INVALID（防注入）。
export function applyUpdate(contract, patch) {
  const frozen = isFrozen(contract.status);
  const next = { ...contract };
  for (const k of Object.keys(patch)) {
    if (IMMUTABLE.has(k)) continue; // 身份/状态/时间戳不可伪造
    if (frozen && BUSINESS_FIELDS.includes(k)) {
      const e = new Error(`冻结字段 ${k} 不可修改（${contract.status === 'active' ? '已生效' : '已归档/作废/到期'}）`);
      e.code = 'FROZEN';
      throw e;
    }
    if (!BUSINESS_FIELDS.includes(k) && !ALWAYS_EDITABLE.includes(k)) {
      const e = new Error(`未知字段不可修改: ${k}`);
      e.code = 'INVALID';
      throw e;
    }
    next[k] = patch[k];
  }
  next.updated_at = new Date().toISOString();
  const v = validateContract(next);
  if (!v.ok) {
    const e = new Error(v.errors.join('; '));
    e.code = 'INVALID';
    throw e;
  }
  return next;
}

// 迁移：白名单 + 角色。返回新对象，不动原对象。非法/越权抛错。
export function transition(contract, to, role) {
  if (!STATES.includes(to)) {
    const e = new Error(`非法状态: ${to}`);
    e.code = 'INVALID_STATE';
    throw e;
  }
  const edge = TRANSITIONS[contract.status]?.to?.[to];
  if (!edge) {
    const e = new Error(`禁止跳转 ${contract.status} → ${to}`);
    e.code = 'ILLEGAL_TRANSITION';
    throw e;
  }
  if (!edge.includes(role)) {
    const e = new Error(`角色 ${role} 无权执行 ${contract.status} → ${to}`);
    e.code = 'FORBIDDEN';
    throw e;
  }
  return { ...contract, status: to, updated_at: new Date().toISOString() };
}