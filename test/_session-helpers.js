// test/_session-helpers.js — T4：把既有 API 测试从 X-User-* 头迁移到 Bearer 会话的共享夹具。
// 用法：bootSessions(dir) 产于含 4 内建用户的 SessionStore；authClient(base) 懒登录、按 role 缓存 token。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionStore, hashPassword } from '../server/auth.js';

export const COST = 1 << 10; // 测试低成本
export const SALT = 'deadbeef00000000';
export const PW = 'pw-' + Date.now() % 100000;
export const USERS = [
  { id: 'u_admin', username: 'admin', role: 'admin' },
  { id: 'u_editor', username: 'editor', role: 'editor' },
  { id: 'u_viewer', username: 'viewer', role: 'viewer' },
  { id: 'u_legal', username: 'legal', role: 'legal' },
];

// 写 users.json + 产 SessionStore（共享 PW/SALT，便于测试登录）。
export async function bootSessions(dir) {
  const usersFile = path.join(dir, 'users.json');
  const rows = USERS.map((u) => ({ ...u, salt: SALT, password_hash: hashPassword(PW, SALT, COST) }));
  await fs.writeFile(usersFile, JSON.stringify(rows));
  return createSessionStore({ file: path.join(dir, 'sessions.json'), usersFile, cost: COST });
}

export async function login(base, username, password = PW) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status} ${await r.text()}`);
  return (await r.json()).data.token;
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// 认证请求客户端：懒登录 + 按角色缓存 token；identity 来自会话（role→内建 user），忽略旧 id 参数。
export async function authClient(base) {
  const cache = new Map();
  const client = {
    async token(role) {
      if (!cache.has(role)) cache.set(role, await login(base, role));
      return cache.get(role);
    },
    async raw(method, p, role, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (role) headers.Authorization = `Bearer ${await client.token(role)}`;
      // 字符串 body 原样发送（测 BAD_BODY 用），对象才 JSON.stringify。
      const sent = body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
      const r = await fetch(base + p, { method, headers, body: sent });
      return r;
    },
    // 旧 req 形态：返回 {status, json}（204 无 body → json=null）。
    async reqJson(method, p, role, body) {
      const r = await client.raw(method, p, role, body);
      let json = null;
      try { json = await r.json(); } catch { /* 204 等无 body */ }
      return { status: r.status, json };
    },
    async get(p, role = 'viewer') { return client.raw('GET', p, role); },
  };
  return client;
}