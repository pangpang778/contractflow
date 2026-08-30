// shared/consumer.js — outbox 消费状态机 + 渲染变量补全：纯函数，不透传 http/store。
// nextMailState：pending/failed → sent | failed（retry ≤ MAX_RETRY 退避）；已 sent 幂等。
// buildVars：事件载荷 + 相关合同字段 → 渲染变量（金额整数分→元字符串，仅字符串化不做算术）。

export const MAX_RETRY = 3;

/**
 * 邮件消费状态规约。
 * @param {{status?:string, retry_count?:number}} prev 既有事件行（无 status 视为 pending，偏离①兼容）
 * @param {boolean} renderSucceeded 渲染是否成功
 * @returns {{status:'sent'|'failed', retry_count:number}}
 */
export function nextMailState(prev, renderSucceeded) {
  const status = prev.status ?? 'pending';
  const retry = prev.retry_count ?? 0;
  if (status === 'sent') return { status: 'sent', retry_count: retry }; // 已 sent 不迁移
  if (renderSucceeded) return { status: 'sent', retry_count: retry };
  return { status: 'failed', retry_count: Math.min(retry + 1, MAX_RETRY) };
}

/** 金额（整数分）→ 元字符串；非整数/缺失 → 空串（避免浮点入存储，仅展示用）。 */
function yuanString(amount) {
  return Number.isInteger(amount) ? String(amount / 100) : '';
}

/** 从合同补全渲染变量；contract 为 null → {}；缺字段 → 键置 undefined（渲染模板缺失变量补 —）。 */
function varsFromContract(contract) {
  if (!contract) return {};
  return {
    title: contract.title,
    amount_yuan: yuanString(contract.amount),
    counterparty_id: contract.counterparty_id,
    end_date: contract.end_date,
  };
}

/**
 * 事件 → 渲染变量。审批事件（无 payload）用合同补全；到期提醒（self payload）透传并合并合同档。
 * @param {{type:string, payload?:Record<string,unknown>, contract_id?:string}} event
 * @param {object|null} contract
 */
export function buildVars(event, contract) {
  const base = varsFromContract(contract);
  if (event.payload && typeof event.payload === 'object') {
    return { ...base, ...event.payload };
  }
  return base;
}