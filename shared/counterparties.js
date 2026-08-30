// shared/counterparties.js — 相对方领域层：纯函数，不透传 http/store。
// 字段校验、风险评级、信用代码去重、旧种子容错为单一事实源，server 与测试共用。
// 去重编排（list → findDuplicate → write）由 API 层负责，本层只给纯判定。ponytail: 存储复用既有 createFileStore 工厂，不新增薄封装。

import { newCounterpartyId } from './ids.js';

// D-R 五档，默认 C。
export const RISK_RATINGS = ['D', 'C', 'B', 'A', 'R'];
export const DEFAULT_RISK = 'C';

// 统一社会信用代码：18 位字母/数字（大小写皆可）；落库统一转大写，防大小写造成的重复。
const CREDIT_CODE_RE = /^[0-9A-Za-z]{18}$/;

export function isValidCreditCode(s) {
  return typeof s === 'string' && CREDIT_CODE_RE.test(s);
}
const toUpperCode = (c) => String(c).toUpperCase();

// 既有字段集；不可变更新白名单用（防注入未知键）。
const FIELDS = ['name', 'credit_code', 'contact', 'risk_rating'];

export function validateCounterparty(input) {
  const errors = [];
  if (input.name === undefined || String(input.name).trim() === '') errors.push('缺失必填字段: name');
  const code = input.credit_code;
  if (code === undefined || String(code).trim() === '') errors.push('缺失必填字段: credit_code');
  else if (!isValidCreditCode(String(code))) errors.push('credit_code 须为 18 位字母/数字');
  if (input.risk_rating !== undefined && !RISK_RATINGS.includes(input.risk_rating)) {
    errors.push(`risk_rating 须为 ${RISK_RATINGS.join('/')}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export function createCounterparty(input, { now = new Date().toISOString() } = {}) {
  const v = validateCounterparty(input);
  if (!v.ok) {
    const e = new Error(v.errors.join('; '));
    e.code = 'INVALID';
    throw e;
  }
  return {
    id: newCounterpartyId(),
    name: String(input.name),
    credit_code: toUpperCode(String(input.credit_code)),
    contact: input.contact ?? null,
    risk_rating: input.risk_rating ?? DEFAULT_RISK,
    created_at: now,
    updated_at: now,
  };
}

// 不可变更新：白名单逐键放行，未知键 INVALID；返回新版，不 mutate 入参。
export function updateCounterparty(entity, patch, { now = new Date().toISOString() } = {}) {
  for (const k of Object.keys(patch)) {
    if (!FIELDS.includes(k)) {
      const e = new Error(`未知字段不可修改: ${k}`);
      e.code = 'INVALID';
      throw e;
    }
  }
  const merged = { ...entity, ...patch };
  if (patch.credit_code !== undefined) merged.credit_code = toUpperCode(merged.credit_code);
  const next = { ...merged, updated_at: now };
  const v = validateCounterparty(next);
  if (!v.ok) {
    const e = new Error(v.errors.join('; '));
    e.code = 'INVALID';
    throw e;
  }
  return next;
}

// 信用代码唯一去重：返回撞码既有实体（大小写不敏感、空格忽略）；excludeId 用于更新自身时跳过自我判重。无撞 → null。
// 重名+同码="重复"由此覆盖（同码必命中）；仅重名不同码 → 放行。
export function findDuplicate(list, input, excludeId) {
  const needle = String(input.credit_code ?? '').trim().toUpperCase();
  if (!needle) return null;
  return list.find((e) => e.id !== excludeId && String(e.credit_code).trim().toUpperCase() === needle) ?? null;
}

// 旧种子容错：仅 id+name 的旧行 → 风险回填 C、信用代码空、联系人空。用于读路径归一到完整形态。
export function normalizeCounterparty(row) {
  return {
    id: row.id,
    name: row.name,
    credit_code: row.credit_code ?? '',
    contact: row.contact ?? null,
    risk_rating: row.risk_rating ?? DEFAULT_RISK,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}