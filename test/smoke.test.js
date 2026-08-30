import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';
import { bootSessions, authClient } from './_session-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'client');

const _clients = new Map();
async function get(base, p, role = 'editor') {
  if (!_clients.has(base)) _clients.set(base, await authClient(base));
  return (await _clients.get(base)).raw('GET', p, role);
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-smoke-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const sessions = await bootSessions(dir);
  const server = createApp({
    store,
    counterparties: [{ id: 'cp_1', name: '示例供应商' }],
    sessions, staticDir: CLIENT,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base };
}

test('S3 静态可达：/ 返回含挂载点的 HTML', async (t) => {
  const { base } = await setup(t);
  const r = await get(base, '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /id="app"/);
  assert.match(html, /app\.js/);
  assert.match(html, /tokens\.css/);
});

test('S3 静态资源 200：tokens.css 含状态变量、app.js/app.css 可达', async (t) => {
  const { base } = await setup(t);
  const css = await get(base, '/tokens.css');
  assert.equal(css.status, 200);
  assert.match(await css.text(), /--color-status-active/);
  assert.equal((await get(base, '/app.js')).status, 200);
  assert.equal((await get(base, '/app.css')).status, 200);
});

test('S4 审批前端：入口含审批面板钩子 + 登录表单 + session Bearer 脚本，未登录→登录视图', async (t) => {
  const { base } = await setup(t);
  const html = await (await get(base, '/')).text();
  for (const id of ['approval-panel', 'submit-approval', 'approval-action', 'login-form']) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML 应含挂载点 ${id}`);
  }
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.match(html, /id="app" hidden/, '未登录默认隐藏工作台 → 登录视图');
  assert.ok(!/id="role"|id="userid"/.test(html), 'HTML 不再含 mock 角色下拉/用户 id 输入');
  const js = await (await get(base, '/app.js')).text();
  assert.match(js, /localStorage/);
  assert.match(js, /Authorization: `Bearer/);
  assert.match(js, /\/api\/auth\/login/);
  assert.match(js, /\/api\/auth\/logout/);
  assert.match(js, /status === 401/, '401 → 清 token 回登录');
  assert.ok(!/X-User-Id|X-User-Role/.test(js), '不再用 mock 身份头');
  assert.match(js, /\/approval/);
});

test('S3 路径遍历不泄露外部文件：越界 URL 不返回 server 源码', async (t) => {
  const { base } = await setup(t);
  for (const p of ['/../server/app.js', '/..%2f..%2fserver/store.js', '/%2e%2e/server/index.js']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, `不应 200: ${p}`);
    const txt = await r.text().catch(() => '');
    assert.ok(!/createServer|createFileStore/i.test(txt), `不应泄露 server 源码: ${p}`);
  }
});

test('S3 遍历防护经裸 socket 命中：静态面绝不泄露 staticDir 外文件', async (t) => {
  // 用裸 TCP 发送含字面 `..`/`%2e%2e` 的原始请求行，绕过 fetch 的客户端归一化，
  // 并放置 staticDir 的“同级哨兵”，断言哨兵绝不被返回（无论归一化还是守卫兜底）。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-trav-'));
  const publicDir = path.join(dir, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<div id="app"></div>');
  const sentinel = path.join(dir, 'leak-secret.txt'); // staticDir 同级，不应可达
  await fs.writeFile(sentinel, 'TOP-SECRET-SENTINEL');
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const server = createApp({ store, staticDir: publicDir });
  await new Promise((r) => server.listen(0, r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const lines = ['/../leak-secret.txt', '/..%2fleak-secret.txt', '/%2e%2e/leak-secret.txt'];
  for (const target of lines) {
    const body = await new Promise((resolve, reject) => {
      const sock = net.connect(server.address().port, '127.0.0.1', () => {
        sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      sock.on('data', (c) => { data += c; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.ok(!/TOP-SECRET-SENTINEL/.test(body), `哨兵被泄露: ${target}`);
    assert.match(body, /HTTP\/1\.1 404/, `应 404: ${target}`);
  }
});

test('S3 挂载渲染的数据链路：API round-trip 落到列表', async (t) => {
  const { base } = await setup(t);
  const client = await authClient(base);
  const created = await client.raw('POST', '/api/contracts', 'editor', {
    title: '冒烟合同',
    counterparty_id: 'cp_1',
    amount: 123456,
    currency: 'CNY',
    start_date: '2026-09-01',
    end_date: '2027-09-01',
  });
  assert.equal(created.status, 201);

  const list = await get(base, '/api/contracts');
  const json = await list.json();
  assert.equal(json.ok, true);
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].title, '冒烟合同');
});

test('T6 静态挂载：两域 UI 挂载点 + 变更单对照 + 相对方管理 + 只读角色隐写', async (t) => {
  const { base } = await setup(t);
  const html = await (await get(base, '/')).text();
  for (const id of ['cp-panel', 'cp-form', 'cp-list', 'am-panel', 'am-form', 'am-parent', 'am-submit', 'am-approve', 'am-apply', 'am-comparison']) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML 应含挂载点 ${id}`);
  }
  const js = await (await get(base, '/app.js')).text();
  assert.match(js, /\/api\/amendments/);
  assert.match(js, /\/api\/counterparties/);
  assert.match(js, /Authorization: `Bearer/, '写操作带会话 Bearer');
  assert.ok(!/X-User-Id|X-User-Role/.test(js), '不再用 mock 身份头');
  const css = await (await get(base, '/app.css')).text();
  assert.match(css, /\[data-role="viewer"\]/, 'viewer 只读应隐藏写表单');
});

test('T6 全链路冒烟（F-0005 收敛）：active → 变更单提交/审批/应用 → 列表现继任隐父', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-f005-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const amendments = await createFileStore(path.join(dir, 'amendments.json'));
  const sessions = await bootSessions(dir);
  const server = createApp({ store, counterparties: [{ id: 'cp_1', name: '示例供应商' }], amendments, sessions, staticDir: CLIENT });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });

  const client = await authClient(base);
  const post = async (p, role, body) => client.raw('POST', p, role, body);
  const c = await post('/api/contracts', 'editor', { title: 'F合约', counterparty_id: 'cp_1', amount: 1000, currency: 'CNY', start_date: '2026-01-01', end_date: '2026-12-31' });
  assert.equal(c.status, 201);
  const cid = (await c.json()).data.id;
  for (const to of ['in_review', 'pending_sign', 'active']) assert.equal((await post(`/api/contracts/${cid}/status`, 'admin', { to })).status, 200);
  const am = await post('/api/amendments', 'editor', { parent_contract_id: cid, reason: '加价', changes: { amount: 200000 } });
  assert.equal(am.status, 201);
  const amid = (await am.json()).data.id;
  assert.equal((await post(`/api/amendments/${amid}/submit`, 'editor')).status, 200);
  assert.equal((await post(`/api/amendments/${amid}/approve`, 'admin', { comment: 'ok' })).status, 200); // 会话下提交人=editor、审批人=admin，非同一人
  const apply = await post(`/api/amendments/${amid}/apply`, 'admin', undefined);
  assert.equal(apply.status, 200);
  const succ = (await apply.json()).data;
  assert.equal(succ.version, 2);
  const list = await (await client.raw('GET', '/api/contracts', 'viewer')).json();
  assert.deepEqual(list.data.map((x) => x.id), [succ.id], '列表默认只含继任，父合同隐去');
});