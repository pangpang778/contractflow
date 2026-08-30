# T1 签名+投递+退避纯函数域（S1, S2）
- blockedBy: []

## 目标
`shared/webhooks.js` 纯函数域：HMAC 签名、投递器（fetch 注入）、重试/退避状态机（含死信）。零 http/store 透传。

## 改动
- 新增 `shared/webhooks.js`（ESM，纯函数）：
  - `RETRY_DELAYS = [1000, 5000, 25000]`、`DELIVERY_RETRIES = 3`。
  - `signPayload(secret, timestamp, body)` → `HMAC_SHA256(`${timestamp}.${body}`, secret)` hex（node:crypto）。
  - `buildDeliveryBody(event, timestamp)` → `{ timestamp, event }` JSON 串（签名与发送共用同一 canonic body）。
  - `retryDelayMs(n)` → 第 n 次重试间隔（1/5/25s），n<=0/超界 → 0。
  - `nextWebhookState(prev, ok, now)`：`sent` 幂等；`ok`→`sent`；失败 `attempts+1`，`attempts>DELIVERY_RETRIES` → `dead`，否则 `failed` + `next_retry_at = now + retryDelayMs(attempts)`。
  - `deliverWebhook({url, secret}, event, {fetch = globalThis.fetch, now})` → `{ok, status, signature, body}`；POST `body`、头 `X-ContractFlow-Signature`=signature、`X-ContractFlow-Timestamp`=timestamp；2xx→`ok:true`，fetch 抛错/非 2xx→`ok:false` 带 status/error。

## 验收（node --test）
- 新增 `test/webhooks.test.js`：签名恒定且可用 secret+timestamp+body 复算；deliver 头/体正确（注入 fetch 断言）；状态机全转移（pending→sent、failed+attempts、attempts>3→dead、sent 幂等）；退避 1/5/25s；`buildDeliveryBody` 签名一致性。
- 全量 209 用例零回归（纯新文件，不触既有）。

## Review gate
审查：签名走 node:crypto（无自研哈希）、canonic body 签名与发送一致、状态机无浮点、fetch 注入缺省 globalThis 且测试全 mock、纯函数不透传 http/store。