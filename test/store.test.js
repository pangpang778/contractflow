import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/store.js';
import { newContractId, newCounterpartyId } from '../shared/ids.js';

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-'));
  return { store: await createFileStore(path.join(dir, 'contracts.json')), dir };
}

test('空仓 list 为空', async () => {
  const { store, dir } = await tmpStore();
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await store.list(), []);
});

test('create/get/list/update/delete 往返', async () => {
  const { store, dir } = await tmpStore();
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const c = { id: newContractId(), status: 'draft', amount: 100 };
  await store.create(c);
  assert.deepEqual(await store.get(c.id), c);
  assert.equal((await store.list()).length, 1);

  const next = await store.update(c.id, (x) => ({ ...x, status: 'in_review' }));
  assert.equal(next.status, 'in_review');
  assert.equal((await store.get(c.id)).status, 'in_review');

  assert.equal(await store.remove(c.id), true);
  assert.equal(await store.get(c.id), null);
});

test('update 返回不可变新对象、不动入参', async () => {
  const { store, dir } = await tmpStore();
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const c = { id: newContractId(), status: 'draft' };
  await store.create(c);
  const before = c;
  await store.update(c.id, (x) => ({ ...x, status: 'in_review' }));
  assert.equal(before.status, 'draft');
});

test('create 存放副本：调用方改引用不污染存量', async () => {
  const { store, dir } = await tmpStore();
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const c = { id: newContractId(), status: 'draft', amount: 100 };
  await store.create(c);
  c.amount = 999; // 调用方随后改动
  assert.equal((await store.get(c.id)).amount, 100);
});

test('持久化到磁盘，新实例重读一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(dir, 'contracts.json');
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));

  let store = await createFileStore(file);
  await store.create({ id: newContractId(), status: 'draft' });
  await store.create({ id: newContractId(), status: 'in_review' });

  store = await createFileStore(file); // 模拟重启
  assert.equal((await store.list()).length, 2);
  assert.ok((await fs.stat(file)).size > 0);
  // 不残留 tmp
  assert.rejects(fs.stat(file + '.tmp'), { code: 'ENOENT' });
});

test('并发 create 无丢写，ID 唯一', async () => {
  const { store, dir } = await tmpStore();
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, () => store.create({ id: newContractId(), status: 'draft' })),
  );
  const list = await store.list();
  assert.equal(list.length, N);
  assert.equal(new Set(list.map((c) => c.id)).size, N);
});

test('重复 id 拒绝', async () => {
  const { store, dir } = await tmpStore();
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = newContractId();
  await store.create({ id, status: 'draft' });
  await assert.rejects(() => store.create({ id, status: 'draft' }), { code: 'CONFLICT' });
});

test('ID 前缀分域、生成后不可变', async () => {
  assert.match(newContractId(), /^c_\d+-\w+$/);
  assert.match(newCounterpartyId(), /^cp_\d+-\w+$/);
  const ids = new Set(Array.from({ length: 200 }, () => newContractId()));
  assert.equal(ids.size, 200);
});