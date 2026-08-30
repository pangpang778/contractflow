import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createFileStore } from '../server/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'client');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-smoke-'));
  const store = await createFileStore(path.join(dir, 'contracts.json'));
  const server = createApp({
    store,
    counterparties: [{ id: 'cp_1', name: '示例供应商' }],
    staticDir: CLIENT,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base };
}

function get(base, p) {
  return fetch(base + p, { headers: { 'X-User-Role': 'editor' } });
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

test('S4 审批前端：入口含审批面板钩子、legal 身份、mock 用户 id', async (t) => {
  const { base } = await setup(t);
  const html = await (await get(base, '/')).text();
  assert.match(html, /id="approval-panel"/);
  assert.match(html, /id="submit-approval"/);
  assert.match(html, /id="approval-action"/);
  assert.match(html, /value="legal">/);
  assert.match(html, /id="userid"/);
  const js = await (await get(base, '/app.js')).text();
  assert.match(js, /X-User-Id/);
  assert.match(js, /\/approval/);
});

test('S3 路径遍历不泄露外部文件：越界 URL 不返回 server 源码', async (t) => {
  const { base } = await setup(t);
  for (const p of ['/../server/app.js', '/..%2f..%2fserver/store.js', '/%2e%2e/server/index.js']) {
    const r = await fetch(base + p, { headers: { 'X-User-Role': 'editor' } });
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
  const body = JSON.stringify({
    title: '冒烟合同',
    counterparty_id: 'cp_1',
    amount: 123456,
    currency: 'CNY',
    start_date: '2026-09-01',
    end_date: '2027-09-01',
  });
  const created = await fetch(`${base}/api/contracts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Role': 'editor' },
    body,
  });
  assert.equal(created.status, 201);

  const list = await get(base, '/api/contracts');
  const json = await list.json();
  assert.equal(json.ok, true);
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].title, '冒烟合同');
});