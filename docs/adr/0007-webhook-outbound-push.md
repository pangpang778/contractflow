# ADR-0007 — Webhook 出站事件推送（Run D）

- 日期: 2026-08-31
- 状态: accepted
- 关联: `shared/webhooks.js`, `server/app.js` (`/api/webhooks`, `consume`)

## Context
合同/审批/变更单是旁路消费方要感知的事件源（内网报表、钉钉/企微机器人、其他工具）。需要一种内网出站推送协议：可靠（失败可重试）、可鉴权、（secret）可验证、写操作不因推送而卡主请求。约束：零运行时依赖，HMAC 用 `node:crypto`，不引 SDK。

## Decision
1. **签名**：`X-ContractFlow-Signature = HMAC-SHA256(`${timestamp}.${body}`, secret)` hex；`timestamp` ISO 与签名体同源。body = `JSON.stringify({timestamp, event})`，签名与 POST 发送共用同一 canonic body（`buildDeliveryBody`）——接收方可用 secret + timestamp + body 独立复算出 S1 签名校验缝。
2. **事件**：5 类——`contract.created`、`approval.requested`、`approval.approved`、`approval.rejected`、`amendment.applied`。事件点 `fireEnqueue`（await + catch，旁路入队不失败主请求）。
3. **投递**：`POST /api/webhooks/consume` 扫描 pending/failed 作业，对每个 enabled webhook 同步出站投递；失败按 `nextWebhookState` 1s/5s/25s 退避排程 `next_retry_at`，第 4 次 → `dead`（幂等，sent 不动）。返回 `{sent,failed,dead,outbox:{…}}` 统计。
4. **配置**：CRUD 仅 admin；`GET` 永回掩码 `has_secret` 不回明文；`POST /:id/test` 同步试投 `webhook.test` 事件。
5. **secret 存储**：明文存 `data/webhooks.json`（C4 预授权——内网工具、无外网指纹，key 不跨界）。ponytail: 若后续接公网/多租户再换 KMS+加密，检索/签名缝不变。

## Consequences
- 接收方互操作面清晰：验签（timestamp+body）、事件载荷、重试语义。
- 消费为同步轮询（admin/editor 触发），非后台常驻；量大再上独立定时器/worker。
- 入队与主请求解耦——写操作不被推送阻塞。

## Reversibility
可逆。加事件类型是加一处 `fireEnqueue`；换传输（改队列/调度器）只动 consume 与 `deliverWebhook` 注入点，签名契约不变。