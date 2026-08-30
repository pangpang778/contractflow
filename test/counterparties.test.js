import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateCounterparty, createCounterparty, findDuplicate, updateCounterparty,
  normalizeCounterparty, RISK_RATINGS, DEFAULT_RISK,
} from '../shared/counterparties.js';
import { createFileStore } from '../server/store.js';
import { newCounterpartyId } from '../shared/ids.js';

const VALID = { name: '华东供应商', credit_code: '91310000XXXXXXXXXX', contact: '张三' };
const CODE_A = '91310000MA1AB0CD01';
const CODE_B = '91440300MA2CD00000';

test('风险评级五档 D/C/B/A/R、默认 C', () => {
  assert.deepEqual(RISK_RATINGS, ['D', 'C', 'B', 'A', 'R']);
  assert.equal(DEFAULT_RISK, 'C');
});

test('合法输入创建相对方，ID 合规、风险默认 C、时间 ISO', () => {
  const cp = createCounterparty(VALID, { now: '2026-08-30T00:00:00.000Z' });
  assert.match(cp.id, /^cp_\d+-\w+$/);
  assert.equal(cp.name, '华东供应商');
  assert.equal(cp.credit_code, '91310000XXXXXXXXXX');
  assert.equal(cp.risk_rating, 'C');
  assert.equal(cp.created_at, '2026-08-30T00:00:00.000Z');
  assert.equal(cp.updated_at, cp.created_at);
});

test('校验矩阵：缺名称/缺信用代码/非法评级/非法代码长度拒绝', () => {
  assert.equal(validateCounterparty({ ...VALID, name: '' }).ok, false);
  assert.equal(validateCounterparty({ ...VALID, credit_code: '' }).ok, false);
  assert.equal(validateCounterparty({ ...VALID, risk_rating: 'X' }).ok, false);
  assert.equal(validateCounterparty({ ...VALID, credit_code: '12345678901234567' }).ok, false); // 17 位
  assert.equal(validateCounterparty(VALID).ok, true);
});

test('创建返回新对象，不入参 mutate、互不同引用', () => {
  const input = { ...VALID };
  const cp = createCounterparty(input);
  assert.notEqual(cp, input);
  assert.equal(input.risk_rating, undefined); // 默认不入参
  assert.equal(input.id, undefined);
});

test('去重：同信用代码命中并回带既有实体（含重名同码），仅重名不同码放行', () => {
  const a = createCounterparty({ ...VALID, credit_code: CODE_A, name: '甲公司' });
  const list = [a];
  // 同码同名校
  assert.equal(findDuplicate(list, { name: '甲公司', credit_code: CODE_A }), a);
  // 同码不同名
  assert.equal(findDuplicate(list, { name: '另一家', credit_code: CODE_A }), a);
  // 仅重名不同码 → null
  assert.equal(findDuplicate(list, { name: '甲公司', credit_code: CODE_B }), null);
});

test('去重：信用代码大小写不敏感', () => {
  const a = createCounterparty({ ...VALID, credit_code: CODE_A.toLowerCase() });
  assert.equal(findDuplicate([a], { name: 'x', credit_code: CODE_A.toUpperCase() }), a);
});

test('去重：excludeId 更新自身时不自我判重', () => {
  const a = createCounterparty({ ...VALID, credit_code: CODE_A });
  assert.equal(findDuplicate([a], { name: '改名', credit_code: CODE_A }, a.id), null);
});

test('更新返回新对象、保留既有字段、校验生效', () => {
  const a = createCounterparty({ ...VALID, risk_rating: 'B' });
  const next = updateCounterparty(a, { contact: '李四', risk_rating: 'A' }, { now: '2026-09-01T00:00:00.000Z' });
  assert.notEqual(next, a);
  assert.equal(next.name, '华东供应商'); // 未改字段保留
  assert.equal(next.contact, '李四');
  assert.equal(next.risk_rating, 'A');
  assert.equal(a.contact, '张三'); // 原对象不变
  assert.equal(a.risk_rating, 'B');
  assert.throws(() => updateCounterparty(a, { risk_rating: 'Z' }), { code: 'INVALID' });
});

test('旧种子容错：仅 id+name 的行回填风险 C、信用代码空、联系人空', () => {
  const legacy = normalizeCounterparty({ id: 'cp_1', name: '示例供应商' });
  assert.equal(legacy.risk_rating, 'C');
  assert.equal(legacy.credit_code, '');
  assert.equal(legacy.contact, null);
});

test('存储往返：create/get/list/update/remove + 持久化重读一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-cp-'));
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'counterparties.json');
  let store = await createFileStore(file);

  const cp = createCounterparty(VALID);
  await store.create(cp);
  assert.deepEqual(await store.get(cp.id), cp);
  assert.equal((await store.list()).length, 1);

  await store.update(cp.id, (x) => ({ ...x, risk_rating: 'B' }));
  assert.equal((await store.get(cp.id)).risk_rating, 'B');

  // 持久化 + 重启重读
  store = await createFileStore(file);
  assert.equal((await store.list()).length, 1);
  assert.ok((await fs.stat(file)).size > 0);

  assert.equal(await store.remove(cp.id), true);
  assert.equal(await store.get(cp.id), null);
});

test('并发 create 无丢写、ID 唯一', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-cp-'));
  await test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createFileStore(path.join(dir, 'counterparties.json'));
  const N = 40;
  await Promise.all(Array.from({ length: N }, () =>
    store.create(createCounterparty({ ...VALID, credit_code: `${CODE_A.slice(0, 17)}${Math.floor(Math.random() * 10)}` })),
  ));
  const list = await store.list();
  assert.equal(list.length, N);
  assert.equal(new Set(list.map((c) => c.id)).size, N);
});