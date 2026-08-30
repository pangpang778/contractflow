// shared/importer.js — CSV 导入领域纯函数：表头精确匹配、逐行字段校验、最小相对方构造、报告聚合。
// 不透传 http/store；金额恒整数分、币种/日期复用共享枚举与校验，防语义漂移。

import { CURRENCIES } from './rates.js';
import { isValidDate } from './contracts.js';
import { newCounterpartyId } from './ids.js';

// 表头固定顺序（导入 design 契约的单一事实源）。API 层须精确匹配后才喂行。
export const IMPORT_HEADERS = ['编号', '标题', '相对方名', '金额(分)', '币种', '到期日'];

// 表头精确匹配：顺序 + 列名（trim 容忍 BOM/空格）。不匹配 → {ok:false, reason}。
export function parseHeader(headerRow) {
  if (!Array.isArray(headerRow) || headerRow.length !== IMPORT_HEADERS.length) {
    return { ok: false, reason: `表头须 ${IMPORT_HEADERS.length} 列` };
  }
  const cell = (i) => String(headerRow[i] ?? '').trim();
  const mismatch = IMPORT_HEADERS.findIndex((h, i) => cell(i) !== h);
  if (mismatch >= 0) {
    return { ok: false, reason: `表头列 ${mismatch + 1} 应为「${IMPORT_HEADERS[mismatch]}」` };
  }
  return { ok: true };
}

const DIGITS_RE = /^\d+$/;
const AMT_IDX = 3;
const CUR_IDX = 4;
const END_IDX = 5;

/**
 * 逐行校验（纯函数）。row 为 parseCsv 的一行数组，顺序随 IMPORT_HEADERS。
 * 返回：
 *   {skip:true}                    全空行 → API 侧忽略（拖尾换行等）。
 *   {ok:false, errors:[...]}        违规行 → API 侧记 failure 不中断。
 *   {ok:true, contract:{编号,标题,相对方名,金额,币种,到期日}}  合法行。
 * seenIds：批内已出现的编号（Set，含本次已通过的行），用于批内/库内唯一校验的前半段。
 */
export function validateImportRow(row, seenIds) {
  const cell = (i) => String(row?.[i] ?? '').trim();
  if ([0, 1, 2, 3, 4, 5].every((i) => cell(i) === '')) return { skip: true };

  const errors = [];
  const code = cell(0);
  const title = cell(1);
  const cp = cell(2);
  const amt = cell(AMT_IDX);
  const cur = cell(CUR_IDX);
  const end = cell(END_IDX);

  if (code === '') errors.push('缺失必填字段: 编号');
  else if (seenIds.has(code)) errors.push(`编号重复: ${code}`);

  if (title === '') errors.push('缺失必填字段: 标题');
  if (cp === '') errors.push('缺失必填字段: 相对方名');

  if (amt === '') errors.push('缺失必填字段: 金额(分)');
  else if (!DIGITS_RE.test(amt)) errors.push('金额须为非负整数（单位: 分）');
  else if (BigInt(amt) > BigInt(Number.MAX_SAFE_INTEGER)) errors.push('金额超出安全整数上限，无法精确表示（单位: 分）');

  const currency = cur === '' ? 'CNY' : cur;
  if (!CURRENCIES.includes(currency)) errors.push(`币种须为 ${CURRENCIES.join('/')}`);

  if (end === '') errors.push('缺失必填字段: 到期日');
  else if (!isValidDate(end)) errors.push('到期日须为 YYYY-MM-DD');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    contract: { 编号: code, 标题: title, 相对方名: cp, 金额: Number(amt), 币种: currency, 到期日: end },
  };
}

// 相对方不存在时自动建的最小行：CSV 无信用代码，credit_code 留空；形状与 normalizeCounterparty 输出一致。
export function makeImportedCounterparty(name, { now = new Date().toISOString(), id = newCounterpartyId() } = {}) {
  return {
    id,
    name: String(name).trim(),
    credit_code: '',
    contact: null,
    risk_rating: 'C',
    created_at: now,
    updated_at: now,
  };
}

/**
 * 报告纯聚合。lineResults：每数据行一个——合法/null，违规/{line, field, reason}。
 * created：导入侧产生的 {contractIds, counterpartyIds}（先建合同再建相对方，顺序无关，仅回显）。
 * 返回 {total, succeeded, failed, failures, created_contract_ids, created_counterparty_ids}。
 */
export function buildImportReport(lineResults, created = {}) {
  return {
    total: lineResults.length,
    succeeded: lineResults.filter((r) => r == null).length,
    failed: lineResults.filter((r) => r != null).length,
    failures: lineResults.filter((r) => r != null),
    created_contract_ids: created.contractIds ?? [],
    created_counterparty_ids: created.counterpartyIds ?? [],
  };
}