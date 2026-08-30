// shared/search.js — 全文搜索：子串倒排，纯函数，不透传 http/store。
// buildSearchIndex 生成可查询文档快照（重建幂等）；queryIndex 子串匹配、大小写不敏感、
// 无分词、按 updated_at 倒序、分组 {contracts,counterparties}。不写任何存储。
import { normalizeContract } from './rates.js';

// "正文首段"：取描述首行（textarea 换行即段落分界）。
const firstPara = (v) => String(v ?? '').split(/\r?\n/, 1)[0];
const textOf = (parts) => parts.filter((x) => x != null && x !== '').join(' ').toLowerCase();

// 建索引：合同文档文本 = 标题 + id(编号) + 相对方名 + 正文首段（currency 经 normalizeContract 归一）；
// 相对方文档文本 = 名称 + 信用代码。全部 lowercase（大小写不敏感子串）。
export function buildSearchIndex(contracts = [], counterparties = []) {
  const cpName = new Map(counterparties.map((c) => [c.id, c.name ?? '']));
  const docs = [];
  for (const c of contracts) {
    const n = normalizeContract(c);
    docs.push({
      kind: 'contract',
      id: n.id,
      updated_at: n.updated_at ?? '',
      status: n.status,
      entity: n,
      text: textOf([n.title, n.id, cpName.get(n.counterparty_id), firstPara(n.description)]),
    });
  }
  for (const cp of counterparties) {
    docs.push({
      kind: 'counterparty',
      id: cp.id,
      updated_at: cp.updated_at ?? '',
      status: null,
      entity: cp,
      text: textOf([cp.name, cp.credit_code]),
    });
  }
  return { docs };
}

const desc = (a, b) => {
  const x = String(a.updated_at ?? '');
  const y = String(b.updated_at ?? '');
  return x < y ? 1 : x > y ? -1 : 0;
};

// 分组查询：q lower 子串过滤（includes，无分词）；status 仅作用于合同行；各分组 updated_at 倒序。
export function queryIndex(index, q, { status } = {}) {
  const needle = String(q ?? '').toLowerCase();
  if (!needle) return { contracts: [], counterparties: [] };
  const contracts = [];
  const counterparties = [];
  for (const d of index.docs) {
    if (!d.text.includes(needle)) continue;
    if (d.kind === 'contract') {
      if (status !== undefined && status !== '' && d.status !== status) continue;
      contracts.push(d.entity);
    } else {
      counterparties.push(d.entity);
    }
  }
  contracts.sort(desc);
  counterparties.sort(desc);
  return { contracts, counterparties };
}