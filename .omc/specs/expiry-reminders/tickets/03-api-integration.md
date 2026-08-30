# T3 服务端 API 集成 + 消费编排（seam S4）· 候选 (待 C3 批准)

`blockedBy: [T2]` — 依赖消费状态机（S3）与渲染/扫描（T1）纯规约，做 store-bound 编排与 HTTP 端点。
目标：把"扫提醒 + 消费 outbox pending + 落已发送队列"封装成一次可外部触发的动作，并暴露两只读视图端点；这是本功能的 integration-wiring 收口。
状态：ready-for-agent（C2+C3 已批）。

## 交付切片（跨面但单点演示）
- **server/app.js 新增端点**：
  - `POST /api/outbox/consume`（**编辑器触发，`editor/admin`；viewer → 403；无身份 → 401**）：一次跑完整消费——
    1. 扫 `shared/reminders.js`（`alreadySent` = 已发送队列中 `sent_key` 型 dedup_key 集合；纯扫描结果交给消费者）。
    2. 对每份到期提醒 + 每条 pending outbox 事件：`buildVars`（提醒自带 payload / 审批事件用合同店补全）→ `renderTemplate`（S2）→ 成功则写 `data/mails.json`（`dedup_key` 去重，跳过已存在）并标事件 `sent`（`store.update` 落在原事件行 + 记 `rendered`）；渲染失败 → `store.update` 标 `failed` + `retry_count`（S3 规约，≤3）。
    3. 返回本次处理摘要 `{reminders_scanned, mails_written, outbox: {pending, sent, failed}}`。
  - `GET /api/reminders/due`（只读，`requireLevel 0`）：返回当前应提醒清单 = 纯扫描结果（**不写任何存储**，dry-run 视图）。
  - `GET /api/outbox`（只读，`requireLevel 0`）：按 `{pending, sent, failed}` 分组返回 outbox 事件（缺省 status 归 pending，偏离①）。
  - 端点身份：只读两次按 `X-User-Role` 判定；`consume`（改动）按角色挡，`editor/admin` 放行。
- **server/index.js 接线**：`createApp` 入参已含 `contracts/approvals(outbox 事件源)/outbox/mails`；`consume` 内读 `store + outbox + mailbox`（mails 即已发送队列）。
- **测试**：`test/reminder-api.test.js`（S4 HTTP 集成，临时端口真实 server）：consume 全流程、两只读端点、幂等重复触发、权限拒绝矩阵、错误信封、三缺陷类别（缺变量/越权/非法 shapes）各 ≥1。

## 验收条件（机械可判）
1. consume 一次：到期提醒 + pending 审批事件都被渲染并落 `data/mails.json`；对应 outbox 事件标 `sent`（成功）/ `failed`+retry（失败）。
2. 幂等：对同一批 pending 重复 consume → 不产生重复 sent 记录（dedup_key 挡住）。
3. `/api/reminders/due` 返回纯扫描清单且不改任何存储（dry-run）；`/api/outbox` 按 pending/sent/failed 分组。
4. 权限：viewer consume → 403；无身份头两端 → 401，绝不落入业务分支。
5. 错误统一 `{ok,data,error}` 信封、不抛栈、不外泄敏感字段；consume 全程店内异常均被捕获并回包。
6. 既有验收不回归：`node --test` 全仓绿（含 approval-flow / approvals / contracts / http 既有用例）。

## 演示/验证（S4）
`node --test test/reminder-api.test.js` 集成冒烟 + 全仓 `node --test` 回归；临时端口起真实 server，脚本打三个端点验证端到端可审计（mails 落盘、outbox 状态翻转）。