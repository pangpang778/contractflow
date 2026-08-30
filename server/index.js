// server/index.js — 启动接线：存储 + 相对方种子 + 认证(dev 用户/会话) + 审计 + staticDir(client) + 端口。`node server/index.js`

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createFileStore } from './store.js';
import { createSessionStore, hashPassword } from './auth.js';
import { createAuditWriter } from './audit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

// ponytail: dev 默认口令明文写死便于本地起服；正式部署经环境注入/KMS，勿在此硬编码生产口令。
const DEV_PW = process.env.CF_DEV_PASSWORD || 'contractflow-dev';
const SEED = [
  { id: 'u_admin', username: 'admin', role: 'admin' },
  { id: 'u_editor', username: 'editor', role: 'editor' },
  { id: 'u_viewer', username: 'viewer', role: 'viewer' },
  { id: 'u_legal', username: 'legal', role: 'legal' },
];

// 无用户库则种子默认开发账号（统一口令+盐，仅本地便利；登录口令注于 README）。
async function ensureUsers(usersFile) {
  try {
    const existing = JSON.parse(await fs.readFile(usersFile, 'utf8'));
    if (Array.isArray(existing) && existing.length) return;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const salt = randomBytes(16).toString('hex');
  const password_hash = hashPassword(DEV_PW, salt);
  const rows = SEED.map((u) => ({ ...u, salt, password_hash }));
  await fs.mkdir(path.dirname(usersFile), { recursive: true });
  await fs.writeFile(usersFile, JSON.stringify(rows, null, 2));
  console.log(`contractflow: seeded ${rows.length} dev users (uniform password, set CF_DEV_PASSWORD to change)`);
}

async function main() {
  const store = await createFileStore(path.join(DATA, 'contracts.json'));
  const approvals = await createFileStore(path.join(DATA, 'approvals.json')); // 审批链
  const outbox = await createFileStore(path.join(DATA, 'outbox.json')); // 审批事件，F3 消费
  const mails = await createFileStore(path.join(DATA, 'mails.json')); // 已发送队列（到期提醒+审批通知投递物），F4 由此消费
  // 相对方/变更单升级为可读可写存储（T1/T3 领域就绪；老两字段种子被读侧容错归一，不回写迁移）。
  const counterparties = await createFileStore(path.join(DATA, 'counterparties.json'));
  const amendments = await createFileStore(path.join(DATA, 'amendments.json'));
  // 认证 + 审计（Run B）：会话/用户持久化，审计只追加 JSONL。
  const usersFile = path.join(DATA, 'users.json');
  await ensureUsers(usersFile);
  const sessions = await createSessionStore({ file: path.join(DATA, 'sessions.json'), usersFile });
  const audit = await createAuditWriter(path.join(DATA, 'audit.log'));
  const port = Number(process.env.PORT || 3000);
  const app = createApp({
    store, counterparties, approvals, outbox, mails, amendments,
    sessions, audit, staticDir: path.join(ROOT, 'client'),
  });
  app.listen(port, () => console.log(`contractflow: http://localhost:${port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});