// server/audit.js — 审计域：只追加 JSONL 写入器 + 查询过滤纯函数 + 存储写路径埋点（withAudit）。
// actor 经 requestCtx（AsyncLocalStorage）注入；写操作埋点在存储包装层，非 handler 散落。
// ponytail: 单 JSONL 文件，到 ~10MB 或并发争用再评估轮转（data.md 规模约束）。

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';

export const requestCtx = new AsyncLocalStorage(); // request → {id, role}（actor 来源）

export async function createAuditWriter(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 单例锁 + O_APPEND：并发 append 不互相截断。
  let chain = Promise.resolve();
  const withLock = (fn) => { const p = chain.then(fn); chain = p.then(() => {}, () => {}); return p; };
  return {
    append(record) {
      const line = JSON.stringify({ ...record, ts: record.ts ?? new Date().toISOString() });
      return withLock(() => fs.appendFile(file, line + '\n', 'utf8'));
    },
    async list() {
      let txt = '';
      try { txt = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// ISO 时间字符串按字典序可比（UTC 格式），故 from<=ts<=to 直接字符串比较。
export function queryAudit(records, { entity, actor, from, to } = {}) {
  const out = records.filter((r) => {
    if (entity !== undefined && r.entity !== entity) return false;
    if (actor !== undefined && r.actor !== actor) return false;
    if (from !== undefined && r.ts < from) return false;
    if (to !== undefined && r.ts > to) return false;
    return true;
  });
  return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // ts 降序
}

// 变更字段最小差异：旧值/新值只取变化的键（不含相等的）。
function diffObj(old, next) {
  const keys = new Set([...Object.keys(old || {}), ...Object.keys(next || {})]);
  const from = {};
  const to = {};
  for (const k of keys) {
    if (JSON.stringify(old?.[k]) !== JSON.stringify(next?.[k])) {
      if (old?.[k] !== undefined) from[k] = old[k];
      to[k] = next?.[k];
    }
  }
  return { from, to };
}

// 包装存储 create/update/remove → 逐个写操作追一条审计记录。actor 读 requestCtx（缺→system）。
// append 必须 await：审计写入失败 → 请求 5xx（fail-close），绝不悬空 promise 崩进程或静默丢审计。
export function withAudit(store, { entity, audit }) {
  const actor = () => { const s = requestCtx.getStore(); return s ? s.id : 'system'; };
  return {
    ...store,
    async create(row) {
      const out = await store.create(row);
      await audit.append({ actor: actor(), action: `${entity}.create`, entity, entity_id: row.id, from: null, to: row, reason: '' });
      return out;
    },
    async update(id, updater) {
      const old = await store.get(id);
      const out = await store.update(id, updater);
      if (!out) return out; // 未命中不审计
      const { from, to } = diffObj(old, out);
      const reason = from.status !== undefined && to.status !== undefined ? `status ${from.status}→${to.status}` : '';
      await audit.append({ actor: actor(), action: `${entity}.update`, entity, entity_id: id, from, to, reason });
      return out;
    },
    async remove(id) {
      const old = await store.get(id);
      const ok = await store.remove(id);
      if (!ok) return false;
      await audit.append({ actor: actor(), action: `${entity}.remove`, entity, entity_id: id, from: old, to: null, reason: '' });
      return true;
    },
  };
}