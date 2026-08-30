import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, queryIndex } from '../shared/search.js';

const NOW = '2026-08-30T00:00:00.000Z';
const cp = { id: 'cp_1', name: '示例供应商', credit_code: '91310000ABCDEF1234' };
const contracts = [
  {
    id: 'c_1', title: '市集货架采购', counterparty_id: 'cp_1', amount: 1_500_000, currency: 'CNY',
    description: '木制货架整批采购\n含安装', status: 'active', updated_at: NOW,
  },
  {
    id: 'c_2', title: '海外设备引入', counterparty_id: 'cp_1', amount: 720_000, currency: 'USD',
    description: '', status: 'draft', updated_at: '2026-08-29T00:00:00.000Z',
  },
];

test('建索引幂等：同输入两次 build 结果一致（重建即新鲜，无累积）', () => {
  const a = buildSearchIndex(contracts, [cp]);
  const b = buildSearchIndex(contracts, [cp]);
  assert.deepEqual(a, b);
});

test('子串查询：标题/编号/相对方名/正文首段均可命中，返回分组 {contracts,counterparties}', () => {
  const index = buildSearchIndex(contracts, [cp]);

  // 标题子串
  assert.equal(queryIndex(index, '货架').contracts.length, 1);
  assert.equal(queryIndex(index, '货架').contracts[0].id, 'c_1');
  // 编号（c_2）
  assert.equal(queryIndex(index, 'c_2').contracts[0].id, 'c_2');
  // 相对方名 → 合同与相对方双命中
  const q = queryIndex(index, '示例');
  assert.equal(q.contracts.length, 2);
  assert.equal(q.counterparties.length, 1);
  // 正文首段（c_1 描述首行）
  assert.equal(queryIndex(index, '木制').contracts[0].id, 'c_1');

  assert.deepEqual(Object.keys(queryIndex(index, 'x')), ['contracts', 'counterparties']);
});

test('大小写不敏感：英文片段命中不同大小写存量', () => {
  const idx2 = buildSearchIndex(contracts, [{ id: 'cp_2', name: 'Acme Corp', credit_code: '91310000AABBCCDD11' }]);
  assert.equal(queryIndex(idx2, 'acme').counterparties.length, 1);
  assert.equal(queryIndex(idx2, 'aabbccdd').counterparties.length, 1);
});

test('status 过滤仅作用于合同，相对方不受影响', () => {
  const index = buildSearchIndex(contracts, [cp]);
  const active = queryIndex(index, '示例供应商', { status: 'active' });
  assert.deepEqual(active.contracts.map((x) => x.id), ['c_1']);
  assert.equal(active.counterparties.length, 1); // 相对方不被 status 过滤

  const draft = queryIndex(index, '示例供应商', { status: 'draft' });
  assert.deepEqual(draft.contracts.map((x) => x.id), ['c_2']);
});

test('每组按 updated_at 倒序（后更新的在前）', () => {
  const index = buildSearchIndex(contracts, [cp]);
  const r = queryIndex(index, '供应商');
  assert.deepEqual(r.contracts.map((x) => x.id), ['c_1', 'c_2']); // c_1 newer
});

test('空查询：返回空分组（不做全量返回）', () => {
  const index = buildSearchIndex(contracts, [cp]);
  assert.deepEqual(queryIndex(index, ''), { contracts: [], counterparties: [] });
});

test('旧合同缺 currency 归一后仍可索引，不崩', () => {
  const legacy = [{ id: 'c_old', title: '老合同', counterparty_id: 'cp_1', amount: 1, status: 'active', updated_at: NOW }];
  const index = buildSearchIndex(legacy, [cp]);
  assert.equal(queryIndex(index, '老合同').contracts[0].id, 'c_old');
});