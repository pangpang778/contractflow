// shared/webhooks.js - webhook 签名+投递+退避纯函数域：纯函数，不透传 http/store。
// signPayload：HMAC-SHA256(canonical = timestamp + "." + body) hex；签名与发送共用同一 canonic body。
// nextWebhookState：pending/failed -> sent | failed（1/5/25s 退避排程）| dead（第 4 次失败）；已 sent 幂等。
// deliverWebhook：fetch 注入（缺省 globalThis.fetch）的出站投递，返回 signature/body 供独立复算校验。

import { createHmac } from 'node:crypto';

export const RETRY_DELAYS = [1000, 5000, 25000]; // 第 n 次失败后的重试间隔（ms）
export const DELIVERY_RETRIES = 3; // 最大重试次数，超出 -> dead

/** 签名：HMAC_SHA256(`${timestamp}.${body}`, secret) hex -- node:crypto，无自研哈希。 */
export function signPayload(secret, timestamp, body) {
  const canonical = `${timestamp}.${body}`;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/** 投递体：{ timestamp, event } JSON 串 -- 签名与 POST 发送共用同一 canonic body。 */
export function buildDeliveryBody(event, timestamp) {
  return JSON.stringify({ timestamp, event });
}

/** 第 n 次重试间隔：1->1s, 2->5s, 3->25s；n<=0 或超界 -> 0。 */
export function retryDelayMs(n) {
  return RETRY_DELAYS[n - 1] ?? 0;
}

/**
 * 投递状态规约（镜像 nextMailState 语义 + 退避排程 + 死信）。
 * @param {{status?:string, attempts?:number}} prev 既有投递作业（无 status 视为 pending，attempts 缺省 0）
 * @param {boolean} ok 本次投递是否成功
 * @param {number} now 当前时刻（ms epoch，注入保确定性）
 * @returns {{status:'sent'|'failed'|'dead', attempts:number, next_retry_at?:number}}
 */
export function nextWebhookState(prev, ok, now) {
  const status = prev.status ?? 'pending';
  const attempts = prev.attempts ?? 0;
  if (status === 'sent') return { status: 'sent', attempts }; // 已 sent 不迁移（幂等）
  if (ok) return { status: 'sent', attempts };
  const next = attempts + 1;
  if (next > DELIVERY_RETRIES) return { status: 'dead', attempts: next };
  return { status: 'failed', attempts: next, next_retry_at: now + retryDelayMs(next) };
}

/**
 * 出站投递：签名 -> POST；2xx -> ok:true，非 2xx/抛错 -> ok:false（status 0 + error）。
 * 返回 signature/body 供测试用同一 secret+timestamp+body 独立复算（S1 校验缝）。
 * @param {{url:string, secret:string}} webhook 配置
 * @param {object} event 事件载荷
 * @param {{fetch?:Function, now?:number}} deps 注入点（测试全 mock，缺省 globalThis.fetch）
 */
/** 配置校验：url 为 http(s) 地址、secret 写时必填、enabled 布尔。纯判定，API 层 400。 */
export function validateWebhookConfig(input) {
  const errors = [];
  const url = String(input.url ?? '').trim();
  if (!/^https?:\/\/.+/.test(url)) errors.push('url 须为 http(s) 开头的地址');
  if (input.secret === undefined || String(input.secret) === '') errors.push('secret 必填');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') errors.push('enabled 须为布尔');
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export async function deliverWebhook({ url, secret }, event, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  const timestamp = new Date(now).toISOString();
  const body = buildDeliveryBody(event, timestamp);
  const signature = signPayload(secret, timestamp, body);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ContractFlow-Signature': signature,
        'X-ContractFlow-Timestamp': timestamp,
      },
      body,
    });
    if (res.ok) return { ok: true, status: res.status, signature, body };
    return { ok: false, status: res.status, signature, body, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, signature, body, error: err.message };
  }
}
