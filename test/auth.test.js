// test/auth.test.js — T1 会话域（seam S1）：scrypt 哈希 + 登录/校验/吊销/过期/锁定/持久化纯逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionStore, hashPassword, verifyPassword,
  SESSION_TTL_MS, LOCK_THRESHOLD, LOCK_MS,
} from '../server/auth.js';

const COST = 1 << 10; // 测试低成本，防拖慢
const PW = 'pw-' + Date.now() % 100000;

async function writeUsers(dir) {
  const salt = 'deadbeef00000000';
  const users = [
    { id: 'u_admin', username: 'admin', role: 'admin', password_hash: hashPassword(PW, salt, COST), salt },
    { id: 'u_editor', username: 'editor', role: 'editor', password_hash: hashPassword(PW, salt, COST), salt },
    { id: 'u_viewer', username: 'viewer', role: 'viewer', password_hash: hashPassword(PW, salt, COST), salt },
  ];
  const p = path.join(dir, 'users.json');
  await fs.writeFile(p, JSON.stringify(users));
  return p;
}

async function setup(t, { now } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-auth-'));
  const usersFile = await writeUsers(dir);
  const sessionsFile = path.join(dir, 'sessions.json');
  const store = await createSessionStore({ file: sessionsFile, usersFile, cost: COST, now });
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  return { dir, sessionsFile, store };
}

// 1 —— scrypt 往返
test('scrypt 往返：正确密码 true、错误 false、同参两次哈希一致', () => {
  const h1 = hashPassword('secret', 'salt1', COST);
  const h2 = hashPassword('secret', 'salt1', COST);
  assert.equal(h1, h2, '确定性哈希');
  assert.equal(verifyPassword('secret', 'salt1', h1, COST), true);
  assert.equal(verifyPassword('wrong', 'salt1', h1, COST), false);
  assert.equal(verifyPassword('secret', 'salt1', h2, COST), true);
  // 长度不同也不炸（timingSafeEqual 前置长度校验）
  assert.equal(verifyPassword('secret', 'salt1', 'abc', COST), false);
});

// 2 —— 登录成功
test('登录成功：8h 内过期、validate 还原 userId/role、会话落盘', async (t) => {
  const N0 = Date.UTC(2026, 7, 30, 0, 0, 0);
  let clock = N0;
  const { sessionsFile, store } = await setup(t, { now: () => clock });
  const res = await store.login('editor', PW);
  assert.equal(res.userId, 'u_editor');
  assert.equal(res.role, 'editor');
  assert.ok(res.expiresAt > N0 && res.expiresAt <= N0 + SESSION_TTL_MS, 'expiresAt 在 8h 窗口内');
  assert.match(res.token, /^[0-9a-f]{64}$/, 'token = 32B hex');
  // validate 还原
  const s = store.validate(res.token);
  assert.equal(s.userId, 'u_editor');
  assert.equal(s.role, 'editor');
  // 落盘
  const onDisk = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
  assert.ok(onDisk.some((x) => x.token === res.token), '会话已持久化');
});

// 3 —— 过期
test('过期：逾期 validate → null 且会话被清', async (t) => {
  const N0 = Date.UTC(2026, 7, 30, 0, 0, 0);
  let clock = N0;
  const { store } = await setup(t, { now: () => clock });
  const res = await store.login('admin', PW);
  assert.ok(store.validate(res.token), '期内有效');
  clock = N0 + SESSION_TTL_MS + 1;
  assert.equal(store.validate(res.token), null, '逾期为 null');
  assert.equal(store.validate(res.token), null, '惰性删除后再查仍 null');
});

// 4 —— 吊销
test('吊销：revoke 后 validate → null', async (t) => {
  const { store } = await setup(t);
  const res = await store.login('viewer', PW);
  assert.ok(await store.revoke(res.token));
  assert.equal(store.validate(res.token), null);
  assert.equal(await store.revoke(res.token), false, '重复吊销 false');
});

// 5 —— 锁定
test('锁定：5 次错密码 → LOCKED 且 retry_after≈15min，正确密码也拒；成功登录重置', async (t) => {
  const N0 = Date.UTC(2026, 7, 30, 0, 0, 0);
  let clock = N0;
  const { store } = await setup(t, { now: () => clock });
  for (let i = 0; i < LOCK_THRESHOLD; i++) {
    await assert.rejects(() => store.login('editor', 'bad-' + i), (e) => e.code === 'UNAUTHORIZED');
  }
  // 第 LOCK_THRESHOLD 次失败即锁定，下一次（含正确密码）起 423
  await assert.rejects(
    () => store.login('editor', PW),
    (e) => e.code === 'LOCKED' && e.retryAfter > LOCK_MS - 5 * 1000 && e.retryAfter <= LOCK_MS,
    '锁定期正确密码也拒，retry_after≈15min',
  );
  // 成功登录重置失败计数（未锁定用户）
  await assert.rejects(() => store.login('viewer', 'bad'), (e) => e.code === 'UNAUTHORIZED');
  await assert.rejects(() => store.login('viewer', 'bad'), (e) => e.code === 'UNAUTHORIZED');
  assert.ok((await store.login('viewer', PW)).token, '失败后成功');
  await assert.rejects(() => store.login('viewer', 'bad'), (e) => e.code === 'UNAUTHORIZED');
  assert.ok((await store.login('viewer', PW)).token, '重置后需重新累计 5 次才锁');
});

// 6 —— 持久化恢复
test('持久化恢复：重建 SessionStore（同文件）后未过期会话仍可 validate', async (t) => {
  const N0 = Date.UTC(2026, 7, 30, 0, 0, 0);
  const { dir, sessionsFile } = await setup(t);
  const usersFile = path.join(dir, 'users.json');
  const a = await createSessionStore({ file: sessionsFile, usersFile, cost: COST, now: () => N0 });
  const res = await a.login('admin', PW);
  const b = await createSessionStore({ file: sessionsFile, usersFile, cost: COST, now: () => N0 });
  const s = b.validate(res.token);
  assert.equal(s && s.userId, 'u_admin');
  assert.equal(s && s.role, 'admin');
});

// 7 —— 用户不存在与密码错误同一 401
test('用户不存在与密码错误返回同一 UNAUTHORIZED（不泄露用户存在性）', async (t) => {
  const { store } = await setup(t);
  let e1, e2;
  try { await store.login('ghost', 'x'); } catch (e) { e1 = e; }
  try { await store.login('editor', 'x'); } catch (e) { e2 = e; }
  assert.equal(e1.code, 'UNAUTHORIZED');
  assert.equal(e2.code, 'UNAUTHORIZED');
  assert.equal(e1.message, e2.message, '文案一致防枚举');
});

// 8 —— 锁定在内存、重启清零（C4 既答：失败计数不落盘）
test('锁定态内存承载：新 SessionStore（同文件）失败计数清零', async (t) => {
  const N0 = Date.UTC(2026, 7, 30, 0, 0, 0);
  const { dir, sessionsFile } = await setup(t);
  const usersFile = path.join(dir, 'users.json');
  const a = await createSessionStore({ file: sessionsFile, usersFile, cost: COST, now: () => N0 });
  for (let i = 0; i < LOCK_THRESHOLD; i++) await assert.rejects(() => a.login('editor', 'bad'), (e) => e.code === 'UNAUTHORIZED');
  await assert.rejects(() => a.login('editor', PW), (e) => e.code === 'LOCKED');
  const b = await createSessionStore({ file: sessionsFile, usersFile, cost: COST, now: () => N0 });
  assert.ok((await b.login('editor', PW)).token, '重启后计数清零');
});