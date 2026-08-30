// shared/rates.js — 币种 + 汇率折算域：纯函数，不透传 http/store。
// 金额恒为原币整数分；汇率 e6 micro-CNY/单位；折算方向向下取整分（C4 预授权）。
// 单一事实源：CURRENCIES 白名单、toCNY 折算、rateFor 归一、normalizeContract 旧数据补字段。

export const CURRENCIES = ['CNY', 'USD', 'EUR'];
export const DEFAULT_CURRENCY = 'CNY';
export const RATE_SCALE = 1_000_000; // 1 CNY = 1e6 micro；rate 形如 7.2 → 7_200_000

// 折算：CNY 恒等；外币 floor(amount × rate / RATE_SCALE) —— 整数运算、无浮点。
//   rate = micro-CNY / 1 单位（外币 1 元）；amount 为外币分（fen）。
//   量纲：CNY分 = (amount/100 单位) × rate(×1e6 micro/CNY) → amount×rate/1e6。
// date 参数预留溯源位，不参与数学（汇率表为当前快照，无历史/生效日期）。
export function toCNY(amount, currency, rate, date) { // eslint-disable-line no-unused-vars
  // rate<=1 兜底：rateFor 的"视同 CNY"哨兵值（或误传的退化率）恒等返回，防把外币静默折算成近 0（review LOW）。
  if (currency === DEFAULT_CURRENCY || !amount || rate <= 1) return amount;
  return Math.floor((amount * rate) / RATE_SCALE);
}

// 归一汇率查询：rates 形状 {rates:{USD:e6int,EUR:e6int}}；CNY/缺表/缺币种/非正 → 1（Open Assumption：未知外币视同 CNY）。
export function rateFor(rates, currency) {
  if (currency === DEFAULT_CURRENCY) return 1;
  const r = rates && rates.rates && rates.rates[currency];
  return Number.isInteger(r) && r > 0 ? r : 1;
}

// 读侧归一：旧合同补 currency:'CNY'（C4 预授权：不迁移内容只补字段）。返回新对象，不 mutate 入参。
export function normalizeContract(row) {
  return { ...row, currency: row.currency ?? DEFAULT_CURRENCY };
}