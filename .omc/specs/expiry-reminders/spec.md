# 到期提醒 + 通知消费 Spec

> 依 brief（C1），seam S1–S4 已预授权。本文本 = **C2 申请对象**：验收条件 + test seam 列表，连同对预授权 seam 的偏离（①–⑤），一并请人工批准。
> 与既有 approval-workflow spec 的关系：本功能**复用其交付的 outbox 存储与事件**（`approval.requested/approved/rejected`），把"只写不消费"的 outbox 首次变成可消费的投递队列；到期提醒为新增扫描源。

## Problem

合同有 `end_date`（到期日），但系统在合同临近到期时**没有任何提醒**——临近 30/7/1 天的 active 合同无人感知，续约/结算会错过时点而违约或损失。同时，approval-workflow 只把审批事件写进 `data/outbox.json`（标笔记"F3 消费"），从未消费：pending 事件堆积、无 sent/failed 状态、无重试、无已发送可审计记录。本功能补齐两件事：**到期提醒扫描器**（把"哪些 active 合同该提醒、哪一档"算成纯函数）+ **outbox 消费者**（把 pending 事件与新到期提醒渲染成中文邮件，写入已发送队列并标记状态，渲染失败带重试）。

## Solution

三层全部复用既有机械：领域纯函数（`shared/`，不透传 http/store）+ 复用 `createFileStore`（共享 `data/` 存储面）+ 服务端新端点。**不新增任何运行时依赖、不引入数据库、不真发邮件**。

- **领域层 A —— 到期提醒扫描器（`shared/reminders.js`，纯函数，S1）**：输入 `active 合同[] + now + alreadySent(sent-key 集合)` → 输出应提醒清单。对每份 active 合同算 `days_left = ceil((end_date - today)/天)`；对档位 `[30,7,1]` 中每个 `days_left <= T` 且 `sent_key = contract_id:T` 未在 alreadySent 的，发一条 `{contract_id, tier, due_date, days_left, sent_key}` 提醒。**纯函数、时间注入可测**。
- **领域层 B —— 中文模板渲染（`shared/mail.js`，纯函数，S2）**：`renderTemplate(type, vars)` → `{subject, body}`。模板按事件类型取中文主题/正文，`{{var}}` 双花括号占位；变量替换 + 替换值 **HTML 转义** + **缺变量容错**（缺位补 `—` 不崩）。
- **领域层 C —— 消费状态机（`shared/consumer.js`，纯函数，S3）**：`nextMailState(prev, renderResult)` 规约 `pending → sent|failed`，`failed` 时 `retry_count +1`，`retry_count >= 3` 后保持 failed（退避上限）。纯规约，不打 store。
- **服务端接线（S4）**：消费者编排在 `server/`（store-bound）：读 pending 事件 → 用合同店补全变量（`buildVars`）→ 过 S2 渲染 → 成功写"已发送队列"并标事件 `sent`、失败标 `failed` + retry。新端点：
  - `GET /api/reminders/due`（当前应提醒清单，纯扫描 dry-run 视图，不消费）
  - `GET /api/outbox`（消费视图：pending/sent/failed 三组）
  - `POST /api/outbox/consume`（**外部触发调用消费者一次**：扫到期提醒 + 消费 pending 事件，non-goal 的 cron 由外部频率调它）
- **去重统一**：outbox 事件以 `dedup_key = event.id` 去重；提醒以 `sent_key` 去重。两者都落在"已发送队列"的 `dedup_key` 上，消费者跳过已存在的 key。

### 数据模型（去重 + 状态）

- **outbox 事件行**（既有 `data/outbox.json`，approval-workflow 交付，本功能加状态字段）：`{id, type, contract_id, ..., at, status: pending|sent|failed, retry_count, rendered?: {subject, body}, error?}`。**现有已写事件无 status → 消费者把缺省视为 `pending`**（见偏离①）。
- **已发送队列**：`data/mails.json`，每条 `{dedup_key, type, contract_id, recipient_hint, subject, body, sent_at}`，`dedup_key = event.id | sent_key`。**消费者发送侧落此文件 = 可审计的投递物**，F4 投递通道上线后由此消费。
- 不新增多余存储；`data/` 三项（contracts / outbox / mails）共用 `createFileStore`。

## User Stories

编号（US-E1…US-E6），各带可测验收条件；锚定预授权 seam S1–S4，机械可判。

- **US-E1 到期提醒扫描（active 合同 → 应提醒清单）**
  given 若干 active 合同 + 当前时间 → 算三档应提醒清单。
  验收（S1）：① 到期前 30 天内 → 触发 30 档；7 天内 → 触发 7 档（30 已发过的不重发）；当天到期（days_left=0）→ 仍触发 1 档；② **已过期**（end_date < today，含自动 expired 态）不产提醒；**无到期日**（缺失 end_date）跳过不崩；③ **去重**：alreadySent 含某 `sent_key` → 该档不重发，其余档照发；④ 非 active 态（draft/in_review/pending_sign/终态）不产提醒；⑤ 每条提醒结构齐全：`contract_id / tier(30|7|1) / due_date / days_left / sent_key`，`sent_key = contract_id:tier` 唯一。
- **US-E2 中文模板渲染（纯函数，S2）**
  given 事件类型 + 变量 → 渲染中文主题+正文；缺变量不崩；替换值转义。
  验收（S2）：① `approval.requested/approved/rejected`、`reminder.due` 各类型有中文模板（主题+正文）；② `{{title}}` 等占位被变量替换；③ **缺变量容错**：模板引用但 vars 缺该键 → 输出 `—`，不抛错；④ **HTML 转义**：变量值含 `<`、`&`、`"` 等 → 渲染正文中转义，不注入原始 HTML；⑤ 输出形状稳定 `{subject, body}`，可被消费者直接落盘。
- **US-E3 outbox 消费状态机（pending→sent/failed，重试退避，S3）**
  given 消费一次 → pending 事件被渲染并标 sent；渲染失败标 failed 且 retry 递增，≤3 次。
  验收（S3）：① pending 事件渲染成功 → `status: sent`，`rendered` 落 {subject,body}，且写入已发送队列（`data/mails.json` 出现该 `dedup_key`）；② 渲染失败（模板缺关键变量致无法渲染/抛错）→ `status: failed`、`retry_count +1`；③ 同事件再消费，`retry_count < 3` 且如今渲染成功 → 转 sent；`retry_count >= 3` 仍失败 → 保持 failed、不再递增（退避上限）；④ 已 sent 的事件不再重复消费（dedup 幂等）。
- **US-E4 消费者编排（补全变量 + 触发，S4）**
  given 外部触发一次消费 → 扫描提醒 + 消费 outbox pending，全流程落盘可审计。
  验收（S4）：① `POST /api/outbox/consume` 一次完成：产出的到期提醒与 pending 审批事件被渲染并写入 `data/mails.json`；② outbox 事件被标 `sent/failed`；③ approval 事件渲染前用合同店补全 `title/amount/counterparty_id/end_date` 变量（变量来自事件载荷 + buildVars 补全，见偏离②）；④ 幂等：重复触发不产生重复 sent 记录。
- **US-E5 只读视图端点（S4）**
  `GET /api/reminders/due`、`GET /api/outbox` 只读、不含副作用。
  验收（S4）：① `/api/reminders/due` 返回当前应提醒清单（纯扫描结果，不写任何存储）；② `/api/outbox` 按 `pending/sent/failed` 分组返回 outbox 事件；③ 两端点身份可用 viewer（`requireLevel 0`，只读）；④ 无身份头 → 401，绝不落入业务分支。
- **US-E6 权限/缺陷防护（S4）**
  服务端强校验、统一错误信封，不吞异常。
  验收（S4/S3）：① `consume` 非 GET（POST）且需 `editor/admin`（触发改动）——viewer consume → 403；② 错误统一 `{ok,data,error}` 信封、不抛栈、不外泄敏感字段；③ 所有写操作经 store 原子落盘，错误路径状态一致。

## Implementation Decisions

- **纯函数 ×3，透传零污染**：`shared/reminders.js`（S1）、`shared/mail.js`（S2）、`shared/consumer.js`（S3）均为纯函数，时间/已发送集从参数注入，不 import http/store。
- **金额整数语义**：单位分、禁止浮点（既有规范）；见偏离②，消费者把 `amount`（分）转元字符串后作为变量注入，纯函数只做字符串替换，不做算术。
- **偏离① —— outbox 事件行演进（C2 确认）**：既有 outbox 事件（approval-workflow 写的）无 `status/retry_count/rendered` 字段。本功能通过 `store.update(evt.id, ...)` 在原事件行上累加这些字段，把 outbox 作为**单一状态账本**；**已存在的事件缺 status → 视为 `pending`**。这是对既有交付的向后兼容演进，非新建表，需 C2 明示接受。
- **偏离② —— 变量来源边界（C2 确认）**：brief 说"变量来自事件载荷"，但既有 approval 事件载荷只有 `{contract_id, actor_id, at}`，不含 `title/amount/counterparty`。为同时满足"s2 纯函数可测"与"邮件可读"，拆两层：**`renderTemplate(type, vars)` 只吃变量对象（S2 纯）**；**`buildVars(event, contract)`（补全，约定放 shared/consumer.js 内纯函数）把事件载荷 + 相关合同字段合成渲染变量**。到期提醒由扫描器直接带完整 `payload` 字段，天然满足"变量来自载荷"。金额转元（`amount/100`，整数分→元）作为已有金额展示的延续（见 CONTEXT.md 金额条目）。
- **偏离③ —— 去重落已发送队列（C2 确认）**：brief 的三档去重靠 sent-key；既有 outbox 去重靠事件不重复消费。统一为**已发送队列 `data/mails.json` 的 `dedup_key` 为唯一去重源**：outbox 事件 `dedup_key=event.id`、提醒 `dedup_key=sent_key`。消费者跳过已存在 dedup_key，天然幂等。扫描器（S1）的 alreadySent 即由已发送队列的 sent_key 集合传入（纯函数接口）。
- **偏离④ —— 无前端 / UI（范围确认）**：brief scope boundary 只到"端点 + 扫描器 + 输出"（objective 3 止于两个 GET）。**本 spec 不含前端 slice**；S4 预授权 seam 在 ticket 中收窄为 API 集成。若需工作台展示到期列表，另开 slice，此处不做。
- **偏离⑤ —— 消费触发端点（C4 添补）**：non-goal 明说无 cron 守护、由外部触发调用。补一个显式端点 `POST /api/outbox/consume` 作为**外部频率调用的入口**（cron/定时器/Harness 都打它）——它不是调度器，只是把"扫提醒 + 消费 outbox"封装成一次原子动作。需 C2 认可为必要接线（integration-wiring：切片的输出必须能被挂载/调用）。
- **模板定位**：中文模板（subject/body 带 `{{var}}`）集中在 `shared/mail.js` 的 `TEMPLATES` map，随语言走（文档语言中文）；不为多语言做抽象（YAGNI，brief non-goal）。
- **消费原子性**：consume 端点逐步处理——对每个 pending 事件：渲染成功才写 sent 记录 + 标 sent（同一把 store 锁内完成）；失败标 failed + retry。任一步异常不外泄栈，统一走 `{ok,data,error}`。

## Testing Decisions（只测外部行为）

- 框架 `node:test`（`node --test`），零依赖；金额/领域/权限改动必配测试（process.md）。
- **S1 扫描器单元**：三档触发边界（30/7/1 内、当天到期 days_left=0）、已过期跳过、无到期日跳过、alreadySent 按档去重（同合同不同档仍发）、非 active 过滤、结构形状。
- **S2 渲染器单元**：各事件类型中文模板存在、占位替换、缺变量容错（`—`）、HTML 转义（`<`、`&`、`"`、`'`）、输出形状。
- **S3 状态机单元**：pending→sent、渲染失败→failed+retry、retry<3 恢复成功转 sent、retry>=3 保持 failed 不再递增、已 sent 幂等。
- **S4 HTTP 集成**：临时端口真实 server；consume 全流程（扫描 + 消费 + 落 mails + 标 status）、两只读端点、幂等重复触发、权限拒绝（viewer consume→403）、无身份头→401、错误信封。三缺陷类别（非法状态/越权/缺变量）各 ≥1（process.md 强制）。
- 遗漏缺陷断言：错误信封统一、不抛栈；存储读回 round-trip。

## Out of Scope

真实 SMTP 发送（投递通道 F4 后评估）、cron 守护进程调度器（由外部触发 `consume`）、多语言模板、到期提醒的前端工作台展示（偏离④）、提醒订阅/静默偏好、邮件退订、归档未发送的 failed 清账策略、outbox 容量分片与多实例索引。