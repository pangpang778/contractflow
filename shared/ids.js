// shared/ids.js — 前缀分域、生成后不可变的 id（data.md ID 约定）。

const rand = () => Math.random().toString(16).slice(2, 10);

export function newId(prefix, now = Date.now()) {
  return `${prefix}_${now}-${rand()}`;
}
export const newContractId = () => newId('c');
export const newCounterpartyId = () => newId('cp');