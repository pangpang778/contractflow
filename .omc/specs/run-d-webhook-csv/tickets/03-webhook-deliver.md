# T3 事件接入 + 投递消费（S2 接线）
- blockedBy: [01, 02]

## 目标
关键事件落投递队列 + `POST /api/webhooks/consume` 按状态机送达/重试/死信。

## 改动
- `server/app.js`：`createApp` 增加 DI `webhookDeliveries`（createFileStore）与 `fetchImpl`。
  - 事件入队 helper `enqueueWebhookDelivery(webhooks, webhookDeliveries, event)`：对 `list()` 中每个 `enabled` webhook 落一条作业 `{id,event_type,event,webhook_id,status:'pending',attempts:0,next_retry_at:null,created_at}`（skips 无存储/无 enabled）。**纯编排，不内联 fetch**。
  - 在既有成功路径补入队：
    - `POST /api/contracts` 建成功 → `{type:'contract.created', contract_id, amount, currency, at}`。
    - submit → `approval.requested`；approve → `approval.approved`；reject → `approval.rejected`（event 携 contract_id、chain_id）。
    - amendment apply 成功 → `{type:'amendment.applied', contract_id, parent_contract_id, at}`。
  - `POST /api/webhooks/consume`（editor+ 触发，镜像 `/api/outbox/consume`）：抓取每 enabled webhook 对应作业（`status=dead|sent` 跳、`failed && next_retry_at>now` 跳），`deliverWebhook`（fetchImpl 注入）后 `nextWebhookState` 回写；webhook 已删/禁用 → 作业直接 `dead`；返回 `{processed, sent, failed, dead, outbox:{pending,sent,failed,dead}}`。
- `server/index.js`：接线 `webhookDeliveries = createFileStore(data/webhook_deliveries.json)`。
- `test/webhook-api.test.js`（事件+consume 段）：建合同入队 `contract.created`；审批 submit/approve/reject 入队对应事件；amendment apply 入队；consume 成功→sent；mock fetch 失败→failed+next_retry_at，拨回过去再 consume→重试→死信；无 enabled webhook→consume 空转；viewer 调 consume 403。

## 验收（node --test）
- 事件全部入队 + consume 状态机回环通过；全量 209 用例零回归。

## Review gate
审查：事件点在成功路径之后（失败不误入队）、fetch 只发生在 consume（不在请求热路径）、禁用/删除 webhook 的作业不悬挂、幂等回写、roles 正确。