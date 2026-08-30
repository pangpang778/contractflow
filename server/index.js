// server/index.js — 启动接线：存储 + 相对方种子 + staticDir(client) + 端口。`node server/index.js`

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createApp } from './app.js';
import { createFileStore } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

async function main() {
  const store = await createFileStore(path.join(DATA, 'contracts.json'));
  const approvals = await createFileStore(path.join(DATA, 'approvals.json')); // 审批链
  const outbox = await createFileStore(path.join(DATA, 'outbox.json')); // 审批事件，F3 消费
  const mails = await createFileStore(path.join(DATA, 'mails.json')); // 已发送队列（到期提醒+审批通知投递物），F4 由此消费
  let counterparties = [];
  try {
    counterparties = JSON.parse(await fs.readFile(path.join(DATA, 'counterparties.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const port = Number(process.env.PORT || 3000);
  const app = createApp({ store, counterparties, approvals, outbox, mails, staticDir: path.join(ROOT, 'client') });
  app.listen(port, () => console.log(`contractflow: http://localhost:${port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});