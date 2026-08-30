# T2 outbox 消费状态机 + buildVars 补全（seam S3）· 候选 (待 C3 批准)

`blockedBy: [T1]` — 依赖 S2 渲染器与 S1 扫描器纯规约，做发送侧状态迁移与变量补全。
目标：把"pending 事件/提醒 → sent | failed（retry 退避）"与"事件载荷 → 渲染变量"做成纯规约；存储接线复用 `createFileStore`。
状态：ready-for-agent（C2+C3 已批）。

## 交付切片（跨面但单点演示）
- **shared/consumer.js（S3，纯函数）**：
  - `buildVars(event, contract)` → 渲染变量对象：从事件载荷 + 合同补全（`title/amount_yuan/counterparty_id/end_date/days_left/tier` 依类型）；`amount`（分）→ `amount_yuan = amount/100` 的元字符串，**此处仅字符串化，不做金额算术入存储**。到期提醒由事件自带完整 `payload`（扫描器产生的），approval 事件用合同补。
  - `nextMailState(prev, renderSucceeded)` → 规约：
    - `prev.status` 缺省（undefined）→ 视为 `pending`（偏离①，兼容既有无状态 outbox 事件）。
    - 渲染成功 → `status:'sent'`（沿用既有 retry_count 或 0）。
    - 渲染失败 → `status:'failed'`、`retry_count=(prev.retry_count||0)+1`。
    - `retry_count >= 3` 再失败 → 保持 `failed`、不再递增（退避上限）。
    - 已 `sent` 的事件不再迁移（幂等）。
- **存储接线**：`server/index.js` 复用 `createFileStore` 增建 `data/mails.json`（已发送队列，与 contracts/outbox 平级传入 `createApp`）。mails 记录 `{dedup_key, type, contract_id, recipient_hint, subject, body, sent_at}`，`dedup_key = event.id | sent_key`。
- 测试：`test/consumer.test.js`（S3 纯规约 + buildVars + mails store 读回），`node --test`。

## 验收条件（机械可判）
1. `nextMailState` 全规约过：pending→成功 sent；失败→failed+retry+1；retry<3 后成功→sent；retry>=3 仍失败→保持 failed 不再递增；已 sent→原地不动。
2. 缺省 status 事件按 pending 处理（偏离①兼容）。
3. `buildVars` 对 approval 事件补出 `title/amount_yuan/counterparty_id/end_date`；对 reminder 事件透传自带 payload；`amount_yuan` 为整分→元字符串。
4. mails store 接线：create/list 原子落盘可读回，`dedup_key` 可作去重查询。
5. shared 层零透传 http/store；T1 验收仍由 T1 用例承担（本切片不重复）。

## 演示/验证（S3）
`node --test`：S3 规约 + buildVars 单元、mails store round-trip；`server/index.js` 能起并挂载四份 store（contracts/approvals/outbox/mails）。