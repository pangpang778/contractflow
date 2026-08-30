import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENCIES, DEFAULT_CURRENCY, RATE_SCALE, toCNY, rateFor, normalizeContract,
} from '../shared/rates.js';

test('币种白名单为 spec 集，默认 CNY，汇率刻度 1e6 micro/CNY', () => {
  assert.deepEqual(CURRENCIES, ['CNY', 'USD', 'EUR']);
  assert.equal(DEFAULT_CURRENCY, 'CNY');
  assert.equal(RATE_SCALE, 1_000_000);
});

test('toCNY：CNY 恒等、零金额恒 0、date 参数不参与折算', () => {
  assert.equal(toCNY(500, 'CNY', 7_200_000, '2026-08-30T00:00:00.000Z'), 500);
  assert.equal(toCNY(0, 'USD', 7_200_000), 0);
  assert.equal(toCNY(0, 'CNY', 5), 0);
  assert.equal(toCNY(123, 'CNY', 999), 123); // rate 被忽略
});

test('toCNY 外币折算：rate 为 micro-CNY/单位，金额为外币分，结果 CNY 整数分', () => {
  // 100 USD 分 = 1 USD × 7.2 CNY/USD = 720 CNY 分
  assert.equal(toCNY(100, 'USD', 7_200_000), 720);
  // 100 EUR 分 = 1 EUR × 7.82 CNY/EUR = 782 CNY 分
  assert.equal(toCNY(100, 'EUR', 7_820_000), 782);
  // 整数语义：任何输入都是整数分
  assert.ok(Number.isInteger(toCNY(100, 'USD', 7_200_000)));
});

test('toCNY 向下取整分：分数分截断而非四舍五入', () => {
  // 1 美分 = 0.01 USD × 0.5 CNY/USD = 0.005 CNY = 0.5 分 → 截断 0
  assert.equal(toCNY(1, 'USD', 500_000), 0);
  // 3 美分 = 0.03 USD × 0.5 = 0.015 CNY = 1.5 分 → 截断 1
  assert.equal(toCNY(3, 'USD', 500_000), 1);
});

test('rateFor：CNY→1、表内→rate、缺币种/缺表/非正→1', () => {
  const rates = { base: 'CNY', rates: { USD: 7_200_000, EUR: 7_820_000 } };
  assert.equal(rateFor(rates, 'CNY'), 1);
  assert.equal(rateFor(rates, 'USD'), 7_200_000);
  assert.equal(rateFor(rates, 'EUR'), 7_820_000);
  assert.equal(rateFor(rates, 'XXX'), 1); // 缺币种 → 1（视同 CNY）
  assert.equal(rateFor(undefined, 'USD'), 1); // 缺表 → 1
  assert.equal(rateFor(rates, 'JPY'), 1);
  assert.equal(rateFor({ rates: { USD: 0 } }, 'USD'), 1); // 非正 → 1
  assert.equal(rateFor({ rates: { USD: -5 } }, 'USD'), 1);
  assert.equal(rateFor({ rates: { USD: 1.5 } }, 'USD'), 1); // 非整数 → 1
});

test('normalizeContract：缺 currency 补 CNY、已有保留、返回新对象不 mutate 入参', () => {
  const legacy = { id: 'c_1' };
  const n = normalizeContract(legacy);
  assert.equal(n.currency, 'CNY');
  assert.notEqual(n, legacy); // 新对象
  assert.equal(legacy.currency, undefined); // 入参未被改

  const usd = normalizeContract({ id: 'c_2', currency: 'USD' });
  assert.equal(usd.currency, 'USD');
});