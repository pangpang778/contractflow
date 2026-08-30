// server/store.js — 可替换存储接口 + 文件实现。
// 整存整取、进程内单例锁 serialize read-modify-write、写临时文件 + 原子 rename。
// ponytail: 单例锁，多实例/高并发再换数据库。

import fs from 'node:fs/promises';
import path from 'node:path';

export async function createFileStore(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // 加载现有数据到内存索引
  const byId = new Map();
  try {
    const arr = JSON.parse(await fs.readFile(filePath, 'utf8'));
    for (const c of arr) byId.set(c.id, c);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // 单例锁：串行化所有写
  let chain = Promise.resolve();
  function withLock(fn) {
    const p = chain.then(fn);
    chain = p.then(() => {}, () => {});
    return p;
  }

  async function persist(snapshot) {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2));
    await fs.rename(tmp, filePath);
  }

  const clone = (c) => structuredClone(c);

  // 先落盘、成功后再提交内存索引——persist 失败时内存不被污染（与磁盘一致）。
  return {
    async list() {
      return [...byId.values()].map(clone);
    },
    async get(id) {
      return byId.has(id) ? clone(byId.get(id)) : null;
    },
    async create(contract) {
      return withLock(async () => {
        if (byId.has(contract.id)) {
          const e = new Error(`重复 id: ${contract.id}`);
          e.code = 'CONFLICT';
          throw e;
        }
        const next = clone(contract); // 存副本，防调用方改引用
        await persist([...byId.values(), next]);
        byId.set(contract.id, next);
        return clone(next);
      });
    },
    async update(id, updater) {
      return withLock(async () => {
        const cur = byId.get(id);
        if (!cur) return null;
        const next = updater(clone(cur));
        await persist([...byId.values()].map((c) => (c.id === id ? next : c)));
        byId.set(id, next);
        return clone(next);
      });
    },
    async remove(id) {
      return withLock(async () => {
        if (!byId.has(id)) return false;
        await persist([...byId.values()].filter((c) => c.id !== id));
        byId.delete(id);
        return true;
      });
    },
  };
}