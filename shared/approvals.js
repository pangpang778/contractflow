// shared/approvals.js — 审批链领域层：纯函数，不透传 http/store。
// 金额分级、链/步骤状态机、留痕、提交人自审规则为单一事实源，server 与测试共用。

import { transition } from './contracts.js';
import { newId } from './ids.js';

// 二二级审批门槛：≥ 100,000 元（1,000 万分）需 admin → legal 复核。
export const TWO_LEVEL_THRESHOLD_CENTS = 10_000_000;

// 金额 → 审批链级别（角色集）。提交时点的金额快照决定级别，之后不重开。
export function chainStepsForAmount(amount) {
  return amount >= TWO_LEVEL_THRESHOLD_CENTS
    ? [{ level: 1, role: 'admin' }, { level: 2, role: 'legal' }]
    : [{ level: 1, role: 'admin' }];
}

// 提交即建档：pending 链 + 每步待决留痕位。
export function openChain({ contractId, amount, submitterId, now = new Date().toISOString() }) {
  return {
    id: newId('ap'),
    contract_id: contractId,
    amount,
    submitter_id: submitterId,
    status: 'pending', // pending | approved | rejected
    steps: chainStepsForAmount(amount).map((s) => ({
      ...s,
      outcome: null, // null | approved | rejected
      approver_id: null,
      comment: null,
      decided_at: null,
    })),
    created_at: now,
  };
}

// 当前待决步骤（第一未决）。全决 → null。
export function currentStep(chain) {
  return chain.steps.find((s) => s.outcome === null) ?? null;
}

export function isChainComplete(chain) {
  return chain.steps.length > 0 && currentStep(chain) === null;
}

// 通过/驳回当前步骤：角色精确匹配 + 提交人自审拒绝 + 意见必填；就地不可变返回新链。
export function resolveStep(chain, actor, outcome, comment, now = new Date().toISOString()) {
  const step = currentStep(chain);
  if (!step) {
    const e = new Error('审批链已无待决步骤');
    e.code = 'ILLEGAL_TRANSITION';
    throw e;
  }
  if (step.role !== actor.role) {
    const e = new Error(`当前步骤需角色 ${step.role}`);
    e.code = 'FORBIDDEN';
    throw e;
  }
  if (chain.submitter_id === actor.id) {
    const e = new Error('提交人不能审批自己提交的合同');
    e.code = 'FORBIDDEN';
    throw e;
  }
  if (!comment || !String(comment).trim()) {
    const e = new Error('审批意见必填');
    e.code = 'INVALID';
    throw e;
  }
  const next = { ...chain };
  next.steps = chain.steps.map((s) =>
    s === step ? { ...s, outcome, approver_id: actor.id, comment, decided_at: now } : s,
  );
  next.status = outcome === 'rejected' ? 'rejected' : currentStep(next) === null ? 'approved' : 'pending';
  return next;
}

// 审批链完成态即授权，翻转合同状态。复用 contracts.transition 的边校验防非法跳转；
// 'admin' 仅用于满足其角色白名单（in_review→pending_sign/draft 均放行 admin），真实授权在链。
// ponytail: 链即 authority，通用 /status 的角色白名单对链驱动边不适用。
export function resolveContractStatus(contract, to) {
  return transition(contract, to, 'admin');
}