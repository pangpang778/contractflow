# Mission Brief — 合同审批工作流 (C1)

## Objective
为 in_review 状态的合同实现**多级审批链**：
- editor 提交审批（draft → in_review）时，按**合同金额**自动生成审批链：
  - 金额 < 100,000 元（1,000 万分）→ 1 级：任一 admin 审批
  - 金额 ≥ 100,000 元 → 2 级：admin 审批 → legal 角色复核
- 每级审批通过/驳回都要留痕（谁/何时/意见）
- 驳回 → 合同回 draft 并带驳回意见；重提重新生成审批链
- 全链通过 → approved（可进入签署）

## Scope boundary
- 审批记录独立存储（data/approvals.json，原子写）
- 审批事件写入 **outbox**（data/outbox.json）——本功能不真发邮件，F3 消费
- 权限：仅 admin 可审批；legal 仅参与 2 级链；提交人不能审批自己提交的合同

## Non-goals
真实邮件发送、会签（并行审批）、委托代理、审批链模板化

## Pre-approved seams（C2 预授权）
- S1 审批链生成器（纯函数：金额/角色 → 审批链）
- S2 API 集成（submit/approve/reject 端点 + 留痕 + 权限拒绝矩阵）
- S3 outbox 写入（事件：approval.requested/approved/rejected）
- S4 前端审批操作（审批按钮 + 意见表单 + 驳回原因）

## Ticket 期望
3-4 张垂直切片，串行为主（共享 approvals 存储）。
