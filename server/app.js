// server/app.js — node:http 服务：/api/* CRUD + 迁移 + 角色校验；可选静态托管（T3 接线）。
// 统一错误信封 {ok,data,error}；身份 seam = X-User-Role 头（mock，真认证后替换，ADR-0002）。

import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createContract, validateContract, applyUpdate, transition } from '../shared/contracts.js';

const ROLE_LEVEL = { viewer: 0, editor: 1, admin: 2 };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
};

function sendJson(res, status, data, error) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(error ? { ok: false, error } : { ok: true, data }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('body 非 JSON'), { code: 'BAD_BODY' })); }
    });
    req.on('error', reject);
  });
}

function roleOf(req) {
  const r = String(req.headers['x-user-role'] || '').toLowerCase();
  return r in ROLE_LEVEL ? r : null;
}

// 身份缺失/非法 → 401；角色级不足 → 403。失败已回包，返回 null。
function requireLevel(res, req, min) {
  const role = roleOf(req);
  if (!role) {
    sendJson(res, 401, null, { code: 'UNAUTHORIZED', message: 'missing or invalid X-User-Role' });
    return null;
  }
  if (ROLE_LEVEL[role] < min) {
    sendJson(res, 403, null, { code: 'FORBIDDEN', message: 'insufficient role' });
    return null;
  }
  return { role };
}

export function createApp({ store, counterparties = [], staticDir = null }) {
  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      await route(req, res, pathname);
    } catch (e) {
      // 三个改接口共用：body 非 JSON → 400（而非 500）
      if (e.code === 'BAD_BODY') return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: e.message });
      if (!res.writableEnded) sendJson(res, 500, null, { code: 'INTERNAL', message: '服务端错误' });
    }
  });

  async function route(req, res, pathname) {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    if (pathname === '/api/counterparties' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      return sendJson(res, 200, counterparties);
    }

    if (pathname === '/api/contracts' && req.method === 'POST') {
      const a = requireLevel(res, req, 1 /* editor */);
      if (!a) return;
      const input = await readJsonBody(req);
      const v = validateContract(input);
      if (!v.ok) return sendJson(res, 400, null, { code: 'BAD_REQUEST', message: v.errors.join('; ') });
      try {
        const contract = await store.create(createContract(input));
        return sendJson(res, 201, contract);
      } catch (e) {
        const { status, code } = mapStoreError(e);
        return sendJson(res, status, null, { code, message: e.message });
      }
    }

    if (pathname === '/api/contracts' && req.method === 'GET') {
      if (!requireLevel(res, req, 0)) return;
      return sendJson(res, 200, await store.list());
    }

    let m;
    if ((m = pathname.match(/^\/api\/contracts\/([^/]+)\/status$/)) && req.method === 'POST') {
      const id = m[1];
      const a = requireLevel(res, req, 0); // 迁移角色在领域层判定
      if (!a) return;
      const { to } = await readJsonBody(req);
      try {
        const updated = await store.update(id, (cur) => transition(cur, to, a.role));
        if (!updated) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
        return sendJson(res, 200, updated);
      } catch (e) {
        const code = e.code;
        if (code === 'FORBIDDEN') return sendJson(res, 403, null, { code, message: e.message });
        if (code === 'ILLEGAL_TRANSITION' || code === 'INVALID_STATE') return sendJson(res, 409, null, { code, message: e.message });
        return sendJson(res, 400, null, { code, message: e.message });
      }
    }

    if ((m = pathname.match(/^\/api\/contracts\/([^/]+)$/))) {
      const id = m[1];
      if (req.method === 'GET') {
        if (!requireLevel(res, req, 0)) return;
        const c = await store.get(id);
        return c ? sendJson(res, 200, c) : sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
      }
      if (req.method === 'PATCH') {
        const a = requireLevel(res, req, 1 /* editor */);
        if (!a) return;
        const patch = await readJsonBody(req);
        try {
          const updated = await store.update(id, (cur) => applyUpdate(cur, patch));
          if (!updated) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
          return sendJson(res, 200, updated);
        } catch (e) {
          if (e.code === 'FROZEN') return sendJson(res, 409, null, { code: 'FROZEN', message: e.message });
          if (e.code === 'INVALID') return sendJson(res, 400, null, { code: 'INVALID', message: e.message });
          return sendJson(res, 400, null, { code: e.code, message: e.message });
        }
      }
      if (req.method === 'DELETE') {
        const a = requireLevel(res, req, 2 /* admin */);
        if (!a) return;
        const ok = await store.remove(id);
        if (!ok) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '合同不存在' });
        res.writeHead(204); // 204 不允许携带 body
        return res.end();
      }
    }

    sendJson(res, 404, null, { code: 'NOT_FOUND', message: `无此接口 ${req.method} ${pathname}` });
  }

  async function serveStatic(req, res, pathname) {
    if (!staticDir) return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '无静态面' });
    if (req.method !== 'GET') return sendJson(res, 405, null, { code: 'METHOD_NOT_ALLOWED', message: '仅 GET' });
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const base = path.resolve(staticDir);
    const resolved = path.resolve(base, rel);
    // 必须在 base 之内：base 本身 或 base+sep 为前缀（否则同级前缀目录会被误放行）
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return sendJson(res, 403, null, { code: 'FORBIDDEN', message: '越界路径' });
    }
    try {
      const data = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 404, null, { code: 'NOT_FOUND', message: '静态资源不存在' });
      throw e;
    }
  }
}