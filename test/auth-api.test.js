// test/auth-api.test.js — T2 登录/登出端点 + requireAuth（seam S2）：Bearer 会话替代 X-User-* 头的 HTTP 面。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { createSessionStore, hashPassword } from '../server/auth.js';

const COST = 1 << 10;
const PW = 'pw-' + Date.now() % 100000;
const SALT = 'deadbeef00000000';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-authapi-'));
  const users = [
    { id: 'u_admin', username: 'admin', role: 'admin', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
    { id: 'u_editor', username: 'editor', role: 'editor', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
    { id: 'u_viewer', username: 'viewer', role: 'viewer', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
  ];
  const usersFile = path.join(dir, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify(users));
  const sessions = await createSessionStore({ file: path.join(dir, 'sessions.json'), usersFile, cost: COST });
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const server = createApp({ store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], sessions, staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  return { base, sessions, dir };
}

async function login(base, username, password) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  let json = null; try { json = await r.json(); } catch { /* 204 */ }
  return { status: r.status, json };
}
const bearer = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const VALID = { title: '认证合同', counterparty_id: 'cp_1', amount: 1000, currency: 'CNY', start_date: '2026-01-01', end_date: '2026-12-31' };

test('登录成功：200 含 token/role/expires_at≈8h', async (t) => {
  const { base } = await setup(t);
  const r = await login(base, 'editor', PW);
  assert.equal(r.status, 200);
  assert.ok(r.json.ok);
  assert.match(r.json.data.token, /^[0-9a-f]{64}$/);
  assert.equal(r.json.data.role, 'editor');
  assert.ok(r.json.data.expires_at > Date.now() && r.json.data.expires_at - Date.now() <= 8 * 3600 * 1000);
});

test('错密码与不存在用户同一 401 UNAUTHORIZED（body 一致）', async (t) => {
  const { base } = await setup(t);
  const bad = await login(base, 'editor', 'wrong');
  const ghost = await login(base, 'nobody', PW);
  assert.equal(bad.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(bad.json.error.code, 'UNAUTHORIZED');
  assert.equal(bad.json.error.message, ghost.json.error.message);
});

test('5 次错密码 → 锁定 423 LOCKED；正确密码也拒；v视角正常登入', async (t) => {
  const { base } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await login(base, 'editor', 'bad')).status, 401);
  const locked = await login(base, 'editor', PW);
  assert.equal(locked.status, 423);
  assert.equal(locked.json.error.code, 'LOCKED');
  assert.ok(locked.json.error.retry_after > 0 && locked.json.error.retry_after <= 15 * 60 * 1000);
  assert.equal((await login(base, 'viewer', PW)).status, 200);
});

test('登出：有效 token → 204；再携带原 token 访问 → 401', async (t) => {
  const { base } = await setup(t);
  const lg = await login(base, 'admin', PW);
  const token = lg.json.data.token;
  assert.equal((await fetch(base + '/api/contracts', { headers: bearer(token) })).status, 200);
  const out = await fetch(base + '/api/auth/logout', { method: 'POST', headers: bearer(token) });
  assert.equal(out.status, 204);
  assert.equal((await fetch(base + '/api/contracts', { headers: bearer(token) })).status, 401);
});

test('无/非法/未知 token 访问受保护端点 → 401，不落入业务分支', async (t) => {
  const { base } = await setup(t);
  for (const h of [
    {},
    { Authorization: 'Bearer' },
    { Authorization: `Bearer ${'x'.repeat(128)}` },
    { 'X-User-Role': 'admin' }, // 假角色头无 token
  ]) {
    const r = await fetch(base + '/api/contracts', { headers: h });
    assert.equal(r.status, 401, `header=${JSON.stringify(h)}`);
    assert.equal((await r.json()).error.code, 'UNAUTHORIZED');
  }
});

test('有效 token 但角色不在 ROLE_LEVEL（配置错误）→ 401 而非放行', async (t) => {
  // 回归：requireLevel 过去对未知角色 fail-open（undefined < min 恒 false，含 admin 门徒）。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-badrole-'));
  const users = [
    { id: 'u_admin', username: 'admin', role: 'admin', password_hash: hashPassword(PW, SALT, COST), salt: SALT },
    { id: 'u_bad', username: 'bad', role: 'superuser', password_hash: hashPassword(PW, SALT, COST), salt: SALT }, // 手误/备份恢复的越界角色
  ];
  const usersFile = path.join(dir, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify(users));
  const sessions = await createSessionStore({ file: path.join(dir, 'sessions.json'), usersFile, cost: COST });
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const server = createApp({ store, counterparties: [], sessions, staticDir: null });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });

  const tok = (await login(base, 'bad', PW)).json.data.token;
  const ok = (await login(base, 'admin', PW)).json.data.token;
  assert.equal((await fetch(base + '/api/contracts', { headers: bearer(tok) })).status, 401, '未知角色 fail-closed 401');
  assert.equal((await fetch(base + '/api/contracts', { headers: bearer(ok) })).status, 200, '已知 admin 照常放行');
});

test('角色矩阵经 Bearer 仍生效：viewer 写 403、editor 建 201、admin 删 204', async (t) => {
  const { base } = await setup(t);
  const viewer = bearer((await login(base, 'viewer', PW)).json.data.token);
  const editor = bearer((await login(base, 'editor', PW)).json.data.token);
  const admin = bearer((await login(base, 'admin', PW)).json.data.token);
  assert.equal((await fetch(base + '/api/contracts', { headers: viewer })).status, 200);
  assert.equal((await fetch(base + '/api/contracts', { method: 'POST', headers: viewer, body: JSON.stringify(VALID) })).status, 403);
  const created = await fetch(base + '/api/contracts', { method: 'POST', headers: editor, body: JSON.stringify(VALID) });
  assert.equal(created.status, 201);
  const cid = (await created.json()).data.id;
  assert.equal((await fetch(base + `/api/contracts/${cid}`, { method: 'DELETE', headers: editor })).status, 403);
  assert.equal((await fetch(base + `/api/contracts/${cid}`, { method: 'DELETE', headers: admin })).status, 204);
});