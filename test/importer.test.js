// test/importer.test.js — 导入校验 + 报告 + 最小相对方纯函数（S5，T5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORT_HEADERS, parseHeader, validateImportRow, makeImportedCounterparty, buildImportReport,
} from '../shared/importer.js';

// —— 表头精确匹配 ——
test('IMPORT_HEADERS 顺序与列名精确', () => {
  assert.deepEqual(IMPORT_HEADERS, ['编号', '标题', '相对方名', '金额(分)', '币种', '到期日']);
});

test('parseHeader：精确匹配通过；多/少列、错列名、错顺序拒绝', () => {
  assert.deepEqual(parseHeader(['编号', '标题', '相对方名', '金额(分)', '币种', '到期日']), { ok: true });
  assert.equal(parseHeader(['编号']).ok, false);
  assert.equal(parseHeader(['编号', '标题', '相对方名', '金额', '币种', '到期日']).ok, false, '金额(分)→金额 错');
  assert.equal(parseHeader(['标题', '编号', '相对方名', '金额(分)', '币种', '到期日']).ok, false, '顺序错');
});

// —— 逐行校验 ——
test('validateImportRow：合法行 → ok + contract 归一', () => {
  const seen = new Set();
  const r = validateImportRow(['HT-001', '采购合同', '示例供应商', '1500000', 'USD', '2027-09-01'], seen);
  assert.equal(r.ok, true);
  assert.equal(r.contract.编号, 'HT-001');
  assert.equal(r.contract.金额, 1_500_000); // 整数分，非负
  assert.equal(r.contract.币种, 'USD');
  assert.equal(r.contract.到期日, '2027-09-01');
  assert.equal(seen.has('HT-001'), false, 'seenIds 由调用方加入，本函数不改');
});

test('validateImportRow：空币种默认 CNY；空行 skip', () => {
  assert.equal(validateImportRow(['HT-2', 'p', 'cp', '100', '', '2027-09-01'], new Set()).contract.币种, 'CNY');
  assert.deepEqual(validateImportRow(['', '', '', '', '', ''], new Set()), { skip: true });
});

test('validateImportRow：缺失必填字段逐项报错', () => {
  const noCode = validateImportRow(['', 't', 'cp', '100', 'CNY', '2027-09-01'], new Set());
  assert.equal(noCode.ok, false);
  assert.ok(noCode.errors.some((e) => e.includes('编号')));
  assert.ok(validateImportRow(['a', '', 'cp', '100', 'CNY', '2027-09-01'], new Set()).ok === false, '缺标题');
  assert.ok(validateImportRow(['a', 't', '', '100', 'CNY', '2027-09-01'], new Set()).ok === false, '缺相对方名');
  assert.ok(validateImportRow(['a', 't', 'cp', '', 'CNY', '2027-09-01'], new Set()).ok === false, '缺金额');
  assert.ok(validateImportRow(['a', 't', 'cp', '100', 'CNY', ''], new Set()).ok === false, '缺到期日');
  // 精度守卫：超安全整数上限的金额拒绝（Number 无法精确表示 → 禁浮点）
  const tooBig = validateImportRow(['a', 't', 'cp', String(Number.MAX_SAFE_INTEGER + 1), 'CNY', '2027-09-01'], new Set());
  assert.equal(tooBig.ok, false, '超 MAX_SAFE_INTEGER 拒绝');
  assert.ok(tooBig.errors.some((e) => e.includes('安全整数上限')));
  const atLimit = validateImportRow(['a', 't', 'cp', String(Number.MAX_SAFE_INTEGER), 'CNY', '2027-09-01'], new Set());
  assert.equal(atLimit.ok, true, '恰好 = MAX_SAFE_INTEGER 精确可表示，放行');
});

test('validateImportRow：编号批内重复拒绝', () => {
  const seen = new Set(['HT-9']);
  const r = validateImportRow(['HT-9', 't', 'cp', '100', 'CNY', '2027-09-01'], seen);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('编号重复')));
});

test('validateImportRow：金额非法（负数/小数/非数字）拒绝；币种非法拒绝；日期非法拒绝', () => {
  assert.ok(validateImportRow(['a', 't', 'cp', '-5', 'CNY', '2027-09-01'], new Set()).ok === false, '负数');
  assert.ok(validateImportRow(['a', 't', 'cp', '12.5', 'CNY', '2027-09-01'], new Set()).ok === false, '小数');
  assert.ok(validateImportRow(['a', 't', 'cp', 'abc', 'CNY', '2027-09-01'], new Set()).ok === false, '非数字');
  assert.ok(validateImportRow(['a', 't', 'cp', '100', 'GBP', '2027-09-01'], new Set()).ok === false, '币种非枚举');
  assert.ok(validateImportRow(['a', 't', 'cp', '100', 'CNY', '2027/09/01'], new Set()).ok === false, '日期非法');
});

// —— 最小相对方 ——
test('makeImportedCounterparty：最小行形状与 normalizeCounterparty 输出一致（credit_code 空、风险 C）', () => {
  const now = '2026-08-31T00:00:00.000Z';
  const cp = makeImportedCounterparty(' 新建供应商 ', { now, id: 'cp_new' });
  assert.equal(cp.id, 'cp_new');
  assert.equal(cp.name, '新建供应商');
  assert.equal(cp.credit_code, '');
  assert.equal(cp.contact, null);
  assert.equal(cp.risk_rating, 'C');
  assert.equal(cp.created_at, now);
  assert.equal(cp.updated_at, now);
});

test('makeImportedCounterparty：缺 id/now 时自动生成', () => {
  const cp = makeImportedCounterparty('x');
  assert.ok(cp.id.startsWith('cp_'), 'id 自动生成带 cp_ 前缀');
  assert.equal(typeof cp.created_at, 'string');
});

// —— 报告聚合 ——
test('buildImportReport：计数与失败行透传', () => {
  const lineResults = [
    null, // 成功
    { line: 2, field: '金额(分)', reason: '金额须为非负整数' },
    null, // 成功
    { line: 4, field: '币种', reason: '币种须为 CNY/USD/EUR' },
  ];
  const report = buildImportReport(lineResults, { contractIds: ['HT-1'], counterpartyIds: ['cp_new'] });
  assert.equal(report.total, 4);
  assert.equal(report.succeeded, 2);
  assert.equal(report.failed, 2);
  assert.deepEqual(report.failures, [lineResults[1], lineResults[3]]);
  assert.deepEqual(report.created_contract_ids, ['HT-1']);
  assert.deepEqual(report.created_counterparty_ids, ['cp_new']);
});