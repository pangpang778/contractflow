# T2 webhook URL 管理 CRUD + 测试发送（S3）
- blockedBy: [01]

## 目标
admin 专属 webhook 配置 CRUD（含 secret 写时校验、GET 掩码）+ `POST /:id/test` 同步试投。

## 改动
- `server/app.js`：`createApp` 增加 DI `webhooks`（createFileStore 实例）。
  - `GET /api/webhooks`（admin）→ 列表，响应行 `{id,name,url,enabled,has_secret,created_at,updated_at}`（不返回 secret）。
  - `POST /api/webhooks`（admin）→ `{name?,url,secret,enabled?=true}`；url 非 http(s) → 400；secret 空 → 400。落库含明文 secret（C4 内网工具）。
  - `PATCH /api/webhooks/:id`（admin）→ 改 url/enabled/name/secret（缺省保留旧值）。
  - `DELETE /api/webhooks/:id`（admin）→ 204。
  - `POST /api/webhooks/:id/test`（admin）→ 取该配置，`deliverWebhook` 同步试投 `{type:'webhook.test'}`（fetch 注入 `fetchImpl ?? globalThis.fetch`），返回 `{sent:boolean,status,error?}`。
  - 角色：一律 `requireLevel(2)`（admin）；后端鉴权，不信前端。
- `shared/webhooks.js`：新增 `validateWebhookConfig(input)` 纯校验（url http(s)、secret 非空，enabled 布尔）。
- `server/index.js`：接线 `webhooks = createFileStore(data/webhooks.json)`。
- 新增 `test/webhook-api.test.js`（CRUD + test send 段）：admin 建/查（secret 掩码）/改/删；url 非法 400；editor/viewer 403；test send 注入 mock fetch 断言 `webhook.test` 送达。

## 验收（node --test）
- 上述 CRUD/试投/角色用例通过；全量 209 用例零回归。

## Review gate
审查：GET 绝不回 secret、写操作均 admin、url 白名单 http/https、幂等删除/404、无 console.log。