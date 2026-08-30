// server/auth.js — 认证域：scrypt+盐密码哈希 + 会话状态机（登录/校验/吊销/过期/锁定/持久化）。
// 纯逻辑可测；哈希 cost 可注入（生产高、测试低）；锁定态内存承载（C4 既答，重启清零）。
// ponytail: dev 会话明文落盘，正式部署接 HttpOnly cookie 或 KMS。

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 8 * 3600 * 1000; // 8h
export const LOCK_THRESHOLD = 5; // 连续失败锁定阈值
export const LOCK_MS = 15 * 60 * 1000; // 15min
const HASH_COST = 1 << 17; // 生产默认成本

export function hashPassword(password, salt, cost = HASH_COST) {
  return scryptSync(String(password), String(salt), 64, { N: cost }).toString('hex');
}

// 常数时间比较；长度不等直接 false（timingSafeEqual 要求等长，先校验防抛）。
export function verifyPassword(password, salt, expectedHash, cost = HASH_COST) {
  const got = Buffer.from(hashPassword(password, salt, cost), 'hex');
  const exp = Buffer.from(String(expectedHash), 'hex');
  return got.length === exp.length && timingSafeEqual(got, exp);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function createSessionStore({ file, usersFile, cost = HASH_COST, now = () => Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  // 用户库：username → user
  const users = new Map();
  for (const u of await readJson(usersFile, [])) users.set(u.username, u);

  // 工作态会话；启动时加载未过期者（重启恢复在线，C4 既答）
  const byToken = new Map();
  for (const s of await readJson(file, [])) {
    if (s.expiresAt > now()) byToken.set(s.token, s);
  }

  // 单例写锁：串行化会话持久化
  let chain = Promise.resolve();
  const withLock = (fn) => { const p = chain.then(fn); chain = p.then(() => {}, () => {}); return p; };
  const persistSessions = () => withLock(() => writeJson(file, [...byToken.values()]));

  // 锁定态（内存，重启清零）：username → {fails, lockedUntil}
  const failed = new Map();

  return {
    async login(username, password) {
      const uname = String(username || '');
      const rec = users.get(uname);
      const t = now();
      const f = failed.get(uname) || { fails: 0, lockedUntil: 0 };
      if (f.lockedUntil > t) {
        const e = new Error('账号已锁定，请稍后重试');
        e.code = 'LOCKED';
        e.retryAfter = f.lockedUntil - t;
        throw e;
      }
      const ok = !!rec && verifyPassword(password, rec.salt, rec.password_hash, cost);
      if (!ok) {
        // 与 rec 无关：无此用户同样累计（锁定键 = 用户名，防对不存在用户无限试密码）
        const next = { fails: f.fails + 1, lockedUntil: f.fails + 1 >= LOCK_THRESHOLD ? t + LOCK_MS : 0 };
        failed.set(uname, next);
        const e = new Error('用户名或密码错误');
        e.code = 'UNAUTHORIZED';
        throw e;
      }
      failed.delete(uname); // 成功登录重置失败计数
      const token = randomBytes(32).toString('hex');
      const session = { token, userId: rec.id, role: rec.role, createdAt: t, expiresAt: t + ttlMs };
      byToken.set(token, session);
      await persistSessions();
      return { token, userId: rec.id, role: rec.role, expiresAt: session.expiresAt };
    },
    validate(token) {
      const s = token && byToken.get(token);
      if (!s) return null;
      if (now() > s.expiresAt) {
        byToken.delete(token); // 惰性清理（内存即可，下一写随 persist 落盘）
        return null;
      }
      return { userId: s.userId, role: s.role, expiresAt: s.expiresAt };
    },
    async revoke(token) {
      if (!token || !byToken.has(token)) return false;
      byToken.delete(token);
      await persistSessions();
      return true;
    },
  };
}