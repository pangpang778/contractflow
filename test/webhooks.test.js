// test/webhooks.test.js - 签名恒定/投递头体/状态机/退避/幂等：纯函数单测，fetch 全 mock（S1/S2）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  RETRY_DELAYS,
  DELIVERY_RETRIES,
  signPayload,
  buildDeliveryBody,
  retryDelayMs,
  nextWebhookState,
  deliverWebhook,
} from '../shared/webhooks.js';

const SECRET = 'whsec_test';
const NOW = 1_750_000_000_000;

/** 独立复算签名（不走被测代码的拼串路径）。 */
function independentSign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

test('常量：退避梯度与重试上限', () => {
  assert.deepEqual(RETRY_DELAYS, [1000, 5000, 25000]);
  assert.equal(DELIVERY_RETRIES, 3);
});

test('signPayload：同入参恒定，且与独立复算一致', () => {
  const a = signPayload(SECRET, '2026-08-31T00:00:00.000Z', '{"x":1}');
  const b = signPayload(SECRET, '2026-08-31T00:00:00.000Z', '{"x":1}');
  assert.equal(a, b);
  assert.equal(a, independentSign(SECRET, '2026-08-31T00:00:00.000Z', '{"x":1}'));
  // 入参变化 -> 签名变化
  assert.notEqual(a, signPayload(SECRET, '2026-08-31T00:00:00.001Z', '{"x":1}'));
  assert.notEqual(a, signPayload('other', '2026-08-31T00:00:00.000Z', '{"x":1}'));
});

test('buildDeliveryBody：稳定产出 { timestamp, event } JSON', () => {
  const event = { type: 'contract.created', contract_id: 'c1' };
  const body = buildDeliveryBody(event, '2026-08-31T00:00:00.000Z');
  assert.equal(body, buildDeliveryBody(event, '2026-08-31T00:00:00.000Z'));
  assert.deepEqual(JSON.parse(body), { timestamp: '2026-08-31T00:00:00.000Z', event });
});

test('deliverWebhook：请求 url/method/头/体正确且签名即发送体签名（可独立复算）', async () => {
  const captured = {};
  const fetchMock = async (url, init) => {
    captured.url = url;
    captured.method = init.method;
    captured.headers = init.headers;
    captured.body = init.body;
    return { ok: true, status: 200 };
  };
  const event = { type: 'contract.created', contract_id: 'c1' };
  const result = await deliverWebhook(
    { url: 'https://example.test/hook', secret: SECRET },
    event,
    { fetch: fetchMock, now: NOW },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(captured.url, 'https://example.test/hook');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.ok(captured.headers['X-ContractFlow-Signature']);
  assert.ok(captured.headers['X-ContractFlow-Timestamp']);
  const timestamp = captured.headers['X-ContractFlow-Timestamp'];
  const parsed = JSON.parse(captured.body);
  assert.equal(parsed.timestamp, timestamp);
  assert.deepEqual(parsed.event, event);
  // 返回体即发送体，且可用同一 secret+timestamp+body 独立复算签名（US-D1）
  assert.equal(result.body, captured.body);
  assert.equal(result.signature, captured.headers['X-ContractFlow-Signature']);
  assert.equal(result.signature, independentSign(SECRET, timestamp, result.body));
  assert.equal(result.signature, signPayload(SECRET, timestamp, buildDeliveryBody(event, timestamp)));
});

test('deliverWebhook：非 2xx -> ok:false 带 status/error', async () => {
  const result = await deliverWebhook(
    { url: 'https://example.test/hook', secret: SECRET },
    { type: 'webhook.test' },
    { fetch: async () => ({ ok: false, status: 500 }), now: NOW },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.ok(result.error);
  assert.ok(result.signature);
  assert.ok(result.body);
});

test('deliverWebhook：fetch 抛错 -> ok:false status 0 带 error', async () => {
  const result = await deliverWebhook(
    { url: 'https://example.test/hook', secret: SECRET },
    { type: 'webhook.test' },
    { fetch: async () => { throw new Error('ECONNREFUSED'); }, now: NOW },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'ECONNREFUSED');
  assert.ok(result.signature);
  assert.ok(result.body);
});

test('deliverWebhook：纯注入，不触全局 fetch', async () => {
  let globalCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { globalCalled = true; return { ok: true, status: 200 }; };
  try {
    await deliverWebhook(
      { url: 'https://example.test/hook', secret: SECRET },
      { type: 'webhook.test' },
      { fetch: async () => ({ ok: true, status: 200 }), now: NOW },
    );
    assert.equal(globalCalled, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('nextWebhookState：pending+ok -> sent（attempts 0）', () => {
  assert.deepEqual(nextWebhookState({}, true, NOW), { status: 'sent', attempts: 0 });
});

test('nextWebhookState：失败退避 1s/5s/25s，第 4 次 -> dead', () => {
  const s1 = nextWebhookState({}, false, NOW);
  assert.deepEqual(s1, { status: 'failed', attempts: 1, next_retry_at: NOW + 1000 });
  const s2 = nextWebhookState(s1, false, NOW);
  assert.deepEqual(s2, { status: 'failed', attempts: 2, next_retry_at: NOW + 5000 });
  const s3 = nextWebhookState(s2, false, NOW);
  assert.deepEqual(s3, { status: 'failed', attempts: 3, next_retry_at: NOW + 25000 });
  const s4 = nextWebhookState(s3, false, NOW);
  assert.deepEqual(s4, { status: 'dead', attempts: 4 });
});

test('nextWebhookState：failed 中途成功 -> sent', () => {
  const failed = { status: 'failed', attempts: 2, next_retry_at: NOW + 5000 };
  assert.deepEqual(nextWebhookState(failed, true, NOW), { status: 'sent', attempts: 2 });
});

test('nextWebhookState：已 sent 幂等，不再迁移', () => {
  const sent = { status: 'sent', attempts: 1 };
  assert.deepEqual(nextWebhookState(sent, true, NOW), { status: 'sent', attempts: 1 });
  assert.deepEqual(nextWebhookState(sent, false, NOW), { status: 'sent', attempts: 1 });
});

test('retryDelayMs：1/2/3 -> 1000/5000/25000，越界与 n<=0 -> 0', () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(2), 5000);
  assert.equal(retryDelayMs(3), 25000);
  assert.equal(retryDelayMs(0), 0);
  assert.equal(retryDelayMs(4), 0);
});
