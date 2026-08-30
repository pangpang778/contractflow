# T2 审批 API 集成 + outbox（seams S2 + S3）· 候选 (待 C3 批准)

`blockedBy: [01-approval-chain-domain]` — 复用 T1 领域规约与两块 store。
目标：把 submit/approve/reject 端到端变成可测外部行为，并把三事件写入 outbox。
状态：候选 —— 批准后标 `ready-for-agent`。

## 交付切片（跨面但单点演示）
- **身份 seam 扩展（偏离②）**：`roleOf` 沿用 `X-User-Role`；新增读取 `X-User-Id`。提交/审批端点要求两头发送且合法，缺任一/mock 非法 → 401（只读 GET 仍只需角色）。
- **权限模型（偏离①）**：`ROLE_LEVEL` 增 `legal`（read 档，与 viewer 同级，不获建/改/提交权）。`approve/reject` 不走通用 `requireLevel` 数值门槛，而是**精确比对当前步骤必需 `role`** 与调用者的 `X-User-Role`。
- **端点**：
  - `POST /api/contracts/:id/submit`（editor/admin；body 可含 `opinion` 备注）→ 校验 `draft` → `openChain`（金额快照）写 approvals → 合同 `draft→in_review` → outbox 写 `{type:'approval.requested', contract_id, chain_id, actor_id, at}`。返回新合同 + 链。
  - `POST /api/contracts/:id/approve`（当前步骤角色；body 含 `comment` 必填）→ 取链 `currentStep`，校验 `role` 匹配 + `X-User-Id !== submitter_id` → `resolveStep('approved')` 留痕 → 推进下一级；若 `isChainComplete` → 链 `approved` + 合同 `in_review→pending_sign`。返回合同 + 链。
  - `POST /api/contracts/:id/reject`（当前步骤角色；body 含 `comment` 必填）→ 相同权限/提交人校验 → 步 `rejected` + 链 `rejected` + 合同 `in_review→draft`（驳回意见留在链上可查）。返回合同 + 链。
  - 每条动作后 outbox 追加 `approval.approved`（单级通过走此；二级的每级通过也走，取全部通过才翻转状态）或 `approval.rejected`。
- **状态机耦合（偏离④）**：对已提交过链的合同，`POST /:id/status {to:'pending_sign'}` → 409「请完成审批链」；无链合同保留原 admin 迁移（不破坏 contract-crud 用例）。链全通过后的翻转由 T2 服务端以链完成态为授权执行（不过通用迁移白名单）。
- **契约复用**：submit/approve/reject 均调用 shared/approvals.js；contract 迁移复用 shared/contracts.js。
- **接线冒烟（F-0005）**：`server/index.js` 挂载 approvals/outbox store，`createApp({store, approvals, outbox, ...})`；三个新端点在真实 server 上可用。

## 验收条件（机械可判）
1. US-A1：draft submit → 200、合同 `in_review`、approvals 出现 pending 链；`==` 与 `>` 阈值归 2 级；非 draft → 409；viewer submit → 403。
2. US-A2：1 级链 admin approve → 合同进 `pending_sign`、链 `approved`、步骤留痕齐全、outbox 有 `approval.approved`。
3. US-A3：2 级链 admin 过 L1 后仍 `in_review`；跳过 L1 直接 legal approve → 409；角色不匹配 → 403；legal 过 L2 才进 `pending_sign`。
4. US-A4：当前步 reject → 合同回 `draft`、链 `rejected` 带意见、outbox 有 `approval.rejected`；重提生成新链。
5. US-A5 权限拒绝矩阵：身份头缺/非法 → 401；提交人自审 → 403；越权角色 → 403；错误信封统一 `{ok,data,error}`，不抛栈。
6. 金额/非法状态/越权三类缺陷场景各 ≥1（process.md）；outbox 只写不消费，落盘可读回。

## 演示/验证（S2+S3）
`node --test`：临时端口起真实 server（注入内存或临时文件 store + outbox），submit/approve/reject 全流程、权限拒绝矩阵、金额分级端到端、outbox 三事件落盘通过。