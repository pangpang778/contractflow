// shared/mail.js — 中文模板渲染：纯函数，不透传 http/store。
// 事件类型 → {subject, body} 中文模板；{{var}} 双花括号占位替换。
// 缺变量补 "—" 不抛错（容错）；替换值 HTML 转义；未知类型抛错（供 S3 视为渲染失败）。

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MISSING = '—';

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function substitute(str, vars) {
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? MISSING : esc(v);
  });
}

export const TEMPLATES = {
  'approval.requested': {
    subject: '【合同审批】「{{title}}」待审批',
    body: '合同「{{title}}」（相对方 {{counterparty_id}}，金额 ¥{{amount_yuan}}，到期日 {{end_date}}）已通过提交，进入审批流程，请相关角色及时处理。',
  },
  'approval.approved': {
    subject: '【合同审批】「{{title}}」已通过',
    body: '合同「{{title}}」（相对方 {{counterparty_id}}）已通过审批，流程推进至签署阶段。',
  },
  'approval.rejected': {
    subject: '【合同审批】「{{title}}」已驳回',
    body: '合同「{{title}}」（相对方 {{counterparty_id}}）审批被驳回，请修改后重新提交。',
  },
  'reminder.due': {
    subject: '【合同到期】「{{title}}」即将到期',
    body: '合同「{{title}}」（相对方 {{counterparty_id}}，金额 ¥{{amount_yuan}}）将于 {{due_date}} 到期，距今仅 {{days_left}} 天，请安排续约或结算。',
  },
};

/**
 * @param {string} type 事件类型，须在 TEMPLATES 中存在
 * @param {Record<string,unknown>} [vars] 渲染变量
 * @returns {{subject:string, body:string}}
 * @throws {Error} 未知类型（渲染失败路径）
 */
export function renderTemplate(type, vars = {}) {
  const t = TEMPLATES[type];
  if (!t) {
    const e = new Error(`无对应模板: ${type}`);
    e.code = 'NO_TEMPLATE';
    throw e;
  }
  return { subject: substitute(t.subject, vars), body: substitute(t.body, vars) };
}