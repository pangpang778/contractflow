# Run D Spec — Webhook 事件推送 + CSV 批量导入

## Problem
1. **关键事件无外送通道**：合同创建、审批流转、变更单应用等关键事件只落到内部 outbox → 邮件，无对第三方系统的机器可读推送。客户系统无法实时感知合同状态变化，只能轮询/人工。
2. **无批量导入**：多份存量合同只能逐个走新建表单录入，相对方一个个建，效率低且易录错。需要一次上传 CSV 批量建合同。

## Solution
1. **Webhook 事件推送**：对若干客户配置的 URL（`data/webhooks.json` 明文存 secret，C4 预授权内网工具）在关键事件时**出站 POST** 推送，HTTP 体为 `{timestamp, event}` JSON，携带 HMAC-SHA256 签名头 `X-ContractFlow-Signature` 与 `X-ContractFlow-Timestamp`；**指数退避重试 3 次（1s/5s/25s，C4 预授权）→ 死信**。管理端点 admin 仅证书 **CRUD + 测试发送**。投递为主体是**纯函数可测**（fetch 注入），持久化走独立 `webhook_deliveries` 存储 + `POST /api/webhooks/consume` 消费（沿用邮件 outbox 的既有落盘-消费模式）。
   - 事件集（关键事件）：`contract.created`、`approval.requested`、`approval.approved`、`approval.rejected`、`amendment.applied`。
   - 签名 = `HMAC_SHA256(secret, "timestamp" + "." + body)`（`X-ContractFlow-Signature` 头 = hex）。
2. **CSV 批量导入**：`POST /api/contracts/import`（CSV 文本，editor+），表头**固定精确匹配** `编号/标题/相对方名/金额(分)/币种/到期日`（RFC4180 手写解析器，零依赖）。逐行校验，**错误行进报告不中断整批**；相对方按名匹配，不存在**自动创建**；导入报告 JSON 返回成功数/失败行+原因。

## User Stories
- **US-D1**（T1）HMAC 签名：`signPayload(secret, ts, body)` 对同一入参恒定，`deliverWebhook` 的 `X-ContractFlow-Signature` 可用同一 secret+timestamp+body 独立复算校验。
- **US-D2**（T1）退避/死信：投递失败 `attempts` 递增、`next_retry_at` 按 1s/5s/25s 排程；第 4 次再失败 → `dead`；已 `sent` 幂等不再投。
- **US-D3**（T2）URL 管理：admin 可 CRUD webhook 配置（url 必 http/https、secret 写时必填、enabled 开关）；GET 不返回 secret（`has_secret` 布尔）；viewer/editor 一律 403；`POST /:id/test` 同步试投 `webhook.test` 事件并返回结果。
- **US-D4**（T3）事件接入：建合同 → `contract.created`、提交/通过/驳回审批 → `approval.*`、应用变更单 → `amendment.applied`；每事件对**每个启用 webhook** 各落一条投递作业；消费端点按状态机送达/重试/死信，返回分桶计数。
- **US-D5**（T4）CSV 解析：引号字段内逗号/引号转义/换行/CRLF/末位空字段全覆盖；引号未闭合抛 `BAD_CSV`。
- **US-D6**（T5）导入校验：表头非精确匹配拒绝；编号必填且批内/库内不重复；标题/相对方名必填；金额非负整数分；币种在枚举内（空 → CNY）；到期日 ISO 合法。返回 `{ok, errors}`。
- **US-D7**（S6/T6）导入落地：合法行建合同（`编号`=contract id、`到期日`=end_date、`start_date`=导入当日、空币种→CNY），未知相对方按名自动建（同名批内复用）；违规行入 `failures` 不中断；响应 `{total, succeeded, failed, failures:[{line,field,reason}], created_counters_contract/counterparty}`。
- **US-D8**（T6）零回归与权限：editor+ 可导入，viewer 403；全部既有 209 用例零回归。

## Implementation Decisions
- 事件落库走**独立 `webhook_deliveries` 存储**（`data/webhook_deliveries.json`，createFileStore），不复用邮件 outbox——邮件关注渲染、webhook 关注送达/重试/死信，生命周期不同，牵开职责。
- 投递模型 = **出站 outbox-consume**（与邮件 outbox 镜像）：事件点只 `enqueue`，真正 `fetch` 由 `POST /api/webhooks/consume` 触发；进程内不义 fire-and-forget（防丢失/不可测）。`Deliveries` 作业 `{id,event_type,event,webhook_id,status,attempts,next_retry_at,last_error,created_at}`；`status: pending|sent|failed|dead`。
- 签名体制：`canonical = timestamp + "." + body`；头 `X-ContractFlow-Signature`=hex，`X-ContractFlow-Timestamp`=ISO 时间戳。`deliverWebhook({url,secret}, event, {fetch, now})` 纯函数返回 `{ok,status,body,signature}` 供独立校验。
- **fetch 注入**：`createApp({..., fetchImpl})`，consume/test 端点用 `fetchImpl ?? globalThis.fetch`；测试注入可控 mock，定时按作业 `next_retry_at` 与墙钟（测试可把 `next_retry_at` 拨到过去强制重试）。
- webhook 配置 admin 专属（内含 secret，不做 viewer/editor 暴露）；GET 掩 secret。
- 导入金额恒**整数分**（CSV「金额(分)」列）；币种沿用 `CURRENCIES` 白名单；日期延用 `isValidDate`。
- **编号 → contract id**（搜索/展示的"编号"即主键 id）：导入合同 `id=编号`，须库内/批内唯一；空 `start_date` 用导入当日（C4 邻近、可逆，记录于此）。
- 相对方自动创建：CSV 无信用代码，`makeImportedCounterparty(name, now)` 纯函数构最小行（`credit_code:''`，`risk_rating:'C'`），形状与 `normalizeCounterparty` 输出一致；批内按名去重复用同一 id。

## Testing Decisions（外部行为）
- 纯函数单测（node --test）：`test/webhooks.test.js`（签名恒定/投递头体/状态机/退避/幂等）、`test/csv.test.js`（RFC4180 全边界/坏输入抛出）、`test/importer.test.js`（表头/逐行字段/批内核唯一/最小相对方/报告）。
- API 集成：`test/webhook-api.test.js`（CRUD 角色与掩码、test send、建合同/审批/变更单事件入队、consume 送达/失败重试/死信，mock fetch 注入）、`test/import-api.test.js`（成功建合同+相对方自动建、错误行报告不中断、表头不匹配 400、viewer 403）。
- 全程 `node --test`；既有 209 用例零回归（相同共享函数接口不变）。

## Out of Scope
入站 webhook（只出不进）、webhook 事件订阅过滤、CSV 导出、CSV 嵌套复杂类型（日期/金额仅 ISO/整数分）、webhook 重放防护（签名仅权威校验方需要）、历史汇率/大数据量导入分页。