# Run D Closeout — Webhook 事件推送 + CSV 批量导入

- 状态: **已交付（C5 认证）**
- 日期: 2026-08-31
- 分支: `feat/run-d-webhook-csv`（未 commit/push，按指令）
- 验收: `node --test` 全量 **265 pass / 0 fail**（Run C 基线 209 + Run D 新增/更新 56）

## 交付范围（对照 spec 六张票）
| Ticket | 内容 | 交付 |
|---|---|---|
| T1 | webhook 纯函数域 `shared/webhooks.js`（签名/退避/死信/试投） | ✔ |
| T2 | webhook 服务端：CRUD(admin)+secret 掩码+test 试投+5 事件入队 | ✔ |
| T3 | consume 消费：退避 1s/5s/25s → 第 4 次 dead；统计、幂等、哨兵死信 | ✔ |
| T4 | CSV 解析域 `shared/csv.js`（RFC4180 状态机） | ✔ |
| T5 | 导入域 `shared/importer.js`（行校验+自动相对方+报告） | ✔ |
| T6 | 导入 API `POST /api/contracts/import`（错行不中断、批量 201 报告） | ✔ |

Frontier 依赖图执行：`T1,T4 → T2,T5 → T3,T6`（webhook 域与 CSV 域文件面不相交，T1∥T4 并行；各域服务接线再并行）。

## 验证证据
- **自动化**：`node --test` 265/265。新增套件：`test/webhooks.test.js`（12）、`test/csv.test.js`（19）、`test/importer.test.js`（10）、`test/webhook-api.test.js`（10）、`test/import-api.test.js`（5）。
- **独立 Review gate（non-self-approve）**：oh-my-claudecode:code-reviewer 审 `server/*.js` + `shared/{webhooks,csv,importer}.js` → **APPROVE**（0 CRITICAL / 0 HIGH）；HMAC canonical、状态机、掩码、BOM 容错、编号去重均实证 CLEAN。2 MEDIUM 已修复（见下），其余 LOW 记为 Open Assumption。
- **服务端接线**：`server/app.js` 注入 `webhooks/webhookDeliveries/fetchImpl`，四事件点 `await fireEnqueue`；`server/index.js` 挂载 `data/webhooks.json` 与 `data/webhook_deliveries.json`。

## 交付中修复的缺陷（超出票内、由测试/Review 发现）
1. **导入编号丢失（自研 bug）**：`createContract` 仅从第二参 `options` 取 `id`，初稿把 `编号` 放进 input 对象 → 生成随机 id 而非 `编号`。改为 `createContract(input, { id: v.contract.编号 })`。
2. **webhook 路由遮蔽（自研 bug）**：`/api/webhooks/:(id)` 正则 `[^/]+` 吞掉了 `/consume` POST，且无 `/test` 三分段路由。拆出专用 `/([^/]+)/test$`、去掉 `:id` 块 POST → consume 不再被遮蔽。
3. **事件入队竞态（自研 bug）**：`fireEnqueue` 未 await（fire-and-forget），POST 返回后 store 写未落 → 测试/调用方立即查作业表读到 0。事件点改 `await fireEnqueue`（catch 仍包住，旁路不失败主请求）。
4. **导入金额精度（Review MEDIUM）**：`金额(分)` 超 `Number.MAX_SAFE_INTEGER` 时 `Number()` 丢失精确性，违反禁浮点。`validateImportRow` 加 `BigInt(amt) > BigInt(Number.MAX_SAFE_INTEGER)` 拒绝 + 测试锁死。
5. **sent/dead 残留 next_retry_at（Review LOW）**：消费写回 `next.next_retry_at ?? null` 清空陈旧退避时间戳（消除潜在状态重开脚枪）。

## Review-gate Open Assumptions（接受，不入本次代码）
- 入队失败 log-only（不失败主请求）——**ADR/CONTEXT 明文设计**（旁路副作用）；事件丢失仅入 server log。已定位升级路径：失败侧写审计/计数。
- 出站 fetch 无超时——单挂死端点会阻塞当次 consume（同步轮询、内部工具，可接受）；升级：`AbortController` 超时 + 记死信。
- SSRF 仅拦 scheme 不拦 localhost/内网段——admin 专属 CRUD + C4 内网工具；跨公网再上私有网段黑名单。
- 导入报告 `line` 为数据行序号非物理文件行（空行/引号内换行会偏移）——报告"第几条数据"语义已足够。
- 批量导入 O(n²) 全量落盘——tens/hundreds 行量级可接受；大文件再批量化。

## Webhook / CSV 要点
- 签名 `HMAC-SHA256(`${timestamp}.${body}`, secret)` hex，`X-ContractFlow-Signature` + `X-ContractFlow-Timestamp` 头；body 与签名共用 `buildDeliveryBody` → 接收方可独立复算校验。
- 5 事件：`contract.created` / `approval.requested` / `approval.approved` / `approval.rejected` / `amendment.applied`；`webhook.test` 仅试投。
- 消费幂等（sent 不迁移）；webhook 被删/禁用后遗留作业直接 dead；`consume` 返回 `{sent,failed,dead,outbox:{…}}`。
- 导入表头 `编号,标题,相对方名,金额(分),币种,到期日` 精确匹配；RFC4180 引号/CRLF/BOM 处理；错行 `failures[{line,reason}]` 不中断；相对方按名自动建（`credit_code:''` 复用）；空币种→CNY；金额恒（分）整数；`start_date`=导入当日。

## Paper trail
- Spec: `.omc/specs/run-d-webhook-csv/spec.md`
- Tickets（6 张 frontier 序）: `.omc/specs/run-d-webhook-csv/tickets/`
- ADR: `docs/adr/0007-webhook-outbound-push.md`、`docs/adr/0008-csv-batch-import.md`
- 术语: `CONTEXT.md`（Webhook、CSV 批量导入 新增）

## Open Assumptions / 后续
- webhook `secret` 明文存 `data/webhooks.json`（C4 预授权内网工具）；若后续接公网/多租户再换 KMS+加密（ADR 签名缝不变）。
- 消费为同步轮询（admin/editor 触发），非后台常驻；量大再上独立定时器/worker。
- CSV 表头为契约，改动需版本演进；自动相对方后续可走正常维护流补 `credit_code/risk_rating`。