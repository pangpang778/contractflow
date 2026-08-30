// shared/amendments.js — 变更单领域层：纯函数，不透传 http/store。
// 校验、生命周期状态机（draft→in_review→approved→applied）、apply 版本继承与 superseded 指针为单一事实源。
// 复用合同的业务主体字段冻结集作为可变更键；approve 沿用既有"admin 审批/自审拒绝/意见必填"纪律（单级，非合同多级链）。

import { BUSINESS_FIELDS, isValidDate } from './contracts.js';
import { CURRENCIES } from './rates.js';
import { newId } from './ids.js';

export const AMENDMENT_STATUSES = ['draft', 'in_review', 'approved', 'applied', 'rejected'];
export const AMENDMENT_TERMINAL = new Set(['applied', 'rejected']);
export const CHANGED_FIELDS = BUSINESS_FIELDS; // 可变键 = 合同冻结主体字段（只改冻结字段才需变更单）

// 迁移边 + 各边所需角色。applied 只能经 applyAmendment 达成（需产出继任合同），故不列通用出边。
export const TRANSITIONS = {
  draft: { to: { in_review: ['admin', 'editor'] } },
  in_review: { to: { approved: ['admin'], rejected: ['admin'] } },
  approved: { to: {} },
  applied: { to: {} },
  rejected: { to: {} },
};

function missing(input, k) {
  return input[k] === undefined || input[k] === null || String(input[k]).trim() === '';
}

export function validateAmendment(input) {
  const errors = [];
  if (missing(input, 'reason')) errors.push('缺失必填字段: reason');
  if (missing(input, 'parent_contract_id')) errors.push('缺失必填字段: parent_contract_id');
  const changes = input.changes;
  if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
    errors.push('changes 不得为空');
  } else {
    for (const k of Object.keys(changes)) {
      if (!CHANGED_FIELDS.includes(k)) errors.push(`change 含非冻结主体字段: ${k}`);
      const v = changes[k];
      if (v === undefined || v === null || v === '') { errors.push(`change 值缺失: ${k}`); continue; }
      if (k === 'amount' && (!Number.isInteger(v) || v < 0)) errors.push('change amount 必须为非负整数（单位：分）');
      if (k === 'currency' && !CURRENCIES.includes(v)) errors.push(`change currency 必须为 ${CURRENCIES.join('/')}`);
      if ((k === 'start_date' || k === 'end_date') && !isValidDate(v)) errors.push(`change ${k} 须为 YYYY-MM-DD`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export function createAmendment(input, { id, now = new Date().toISOString() } = {}) {
  const v = validateAmendment(input);
  if (!v.ok) {
    const e = new Error(v.errors.join('; '));
    e.code = 'INVALID';
    throw e;
  }
  return {
    id: id ?? newId('am'),
    parent_contract_id: input.parent_contract_id,
    reason: input.reason,
    changes: { ...input.changes },
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
}

// 通用迁移：draft→in_review（记提交人）、in_review→approved/rejected（admin，意见必填，批准自审拒绝）。
// applied 不在此列——须经 applyAmendment 以产出继任合同（防"无版本违规应用"）。
export function transition(amendment, to, actor, { comment, now = new Date().toISOString() } = {}) {
  if (!AMENDMENT_STATUSES.includes(to)) {
    const e = new Error(`非法状态: ${to}`);
    e.code = 'INVALID_STATE';
    throw e;
  }
  const edge = TRANSITIONS[amendment.status]?.to?.[to];
  if (!edge) {
    const e = new Error(`禁止跳转 ${amendment.status} → ${to}`);
    e.code = 'ILLEGAL_TRANSITION';
    throw e;
  }
  if (!edge.includes(actor.role)) {
    const e = new Error(`角色 ${actor.role} 无权执行 ${amendment.status} → ${to}`);
    e.code = 'FORBIDDEN';
    throw e;
  }
  const next = { ...amendment, status: to, updated_at: now };
  if (to === 'in_review') {
    next.submitter_id = actor.id;
    return next;
  }
  // approved / rejected
  if (to === 'approved' && amendment.submitter_id === actor.id) {
    const e = new Error('提交人不能批准自己的变更单');
    e.code = 'FORBIDDEN';
    throw e;
  }
  if (!comment || !String(comment).trim()) {
    const e = new Error('审批意见必填');
    e.code = 'INVALID';
    throw e;
  }
  next.status = to;
  next.approver_id = actor.id;
  next.decision_comment = comment;
  next.decided_at = now;
  return next;
}

/**
 * apply：以父合同主体字段为基线，仅覆盖 changes → 生成继任 v{n+1}（active），父标 superseded 指针。
 * 前置：approved 且父为非 superseded 的 active。返回 { superseded, next, amendment(→applied) }，均新对象。
 */
export function applyAmendment(amendment, parent, { now = new Date().toISOString() } = {}) {
  if (amendment.status !== 'approved') {
    const e = new Error('仅 approved 可应用');
    e.code = 'ILLEGAL_TRANSITION';
    throw e;
  }
  if (!parent) {
    const e = new Error('父合同不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (parent.superseded === true) {
    const e = new Error('父合同已失效，不可再变更');
    e.code = 'ILLEGAL_TRANSITION';
    throw e;
  }
  if (parent.status !== 'active') {
    const e = new Error('仅对已生效（active）父合同应用变更');
    e.code = 'ILLEGAL_TRANSITION';
    throw e;
  }

  const parentVersion = Number.isInteger(parent.version) ? parent.version : 1;
  const baseline = {};
  for (const f of [...CHANGED_FIELDS, 'description']) baseline[f] = parent[f];
  const fields = { ...baseline, ...amendment.changes };

  const next = {
    id: newId('c'),
    ...fields,
    status: 'active',
    version: parentVersion + 1,
    parent_contract_id: parent.id,
    created_at: now,
    updated_at: now,
  };
  const superseded = {
    ...parent,
    superseded: true,
    superseded_by: next.id,
    superseded_at: now,
    updated_at: now,
  };
  const applied = {
    ...amendment,
    status: 'applied',
    resulting_contract_id: next.id,
    applied_at: now,
    updated_at: now,
  };
  return { superseded, next, amendment: applied };
}