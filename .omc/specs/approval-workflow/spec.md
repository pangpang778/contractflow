# 合同审批工作流 Spec

> 依 brief（C1），seam S1–S4 已预授权。本文本 = **C2 申请对象**：验收条件 + test seam 列表，连同对预授权 seam 的偏离，一并请人工批准。

## Problem

合同进入 `in_review` 后，当前实现仅是一次性 admin 迁移动作（contract-crud US4⑤），无**多级审批**、无留痕、无金额分级、无驳回回退。缺少可追溯的审批链：谁审、何时、什么意见、按金额走几级、submitted 后谁来接手——业务无法回答。本功能在 `in_review` 态内引入审批链：按**合同金额**生成级别，逐级通过/驳回均留痕，驳回回 `draft` 可重提，并污染 outbox 供后续邮件（F3）消费。

## Solution

一个覆盖从此前 CRUD 垂直切片复用的分层实现：领域纯函数（shared）+ 复用 storage + 服务端新端点 + 前端审批操作。**存储直接复用已交付的 `createFileStore`**（`data/approvals.json` 存审批链、`data/outbox.json` 存事件），不新增存储机械。

- **领域层（shared/approvals.js，纯函数）**：审批链生成器 S1、链/步骤状态规约、提交/通过/驳回的纯变换。不透传 http/store。
- **概要：提交即建档**——`POST /:id/submit`（draft→in_review）按合同金额快照生成审批链并落 `approvals`，同时写 outbox `approval.requested`。
- **逐级动作**——`POST /:id/approve`、`POST /:id/reject` 只对当前待决步骤生效；通过即迁移到下一级，全链通过才 `in_review→pending_sign`；驳回 → 链 reject + 合同回 `draft`，驳回意见留在链上可追溯；重提重新生成链。
- **outbox**——只写不消费（本功能不真发邮件，F3 后续消费）；事件 `approval.requested / approved / rejected`。
- **权限**——按链上当前步骤的**必需角色**精确判定（不信前端自报）；admin 仅可审批、"legal" 仅参与 2 级链复核、提交人不能审批自己提交的合同（需 `X-User-Id`，见偏离③）。

### 金额分级（单一常量）

- `< 100,000 元`（`< 10,000,000` 分）→ 1 级链：`[{level:1, role:'admin'}]`
- `≥ 100,000 元` → 2 级链：`[{level:1, role:'admin'}, {level:2, role:'legal'}]`

链以 **submit 时点的合同金额快照**生成，后续 `in_review` 内编辑合同主体不重开链（简单且防漂移；`in_review` 仍未冻结属现状，见 Out of Scope）。

### 与既有状态机的关系（偏离④，C2 确认）

现 `in_review→pending_sign` 为 admin-only 原始迁移。本功能使其变为**链驱动**：
- 对**已提交过审批链**的合同，`/status {to:pending_sign}` 一律 409，只能经 `approve` 在链全通过时达成；全链通过后服务端以链完成态为授权翻转 `in_review→pending_sign`，不再按单步角色走通用迁移白名单（避免 `legal` 收尾时因非 admin 被 403，也防止 raw 穿越）。
- 对**从未走 submit、无链**的合同（既有 contract-crud 测试路径），保留原 admin 原始迁移，不破坏已交付用例。
- 这是对已交付 US4⑤ 的演化，非破坏——但需 C2 明示接受。

## User Stories

编号（US-A1…US-A6），各带可测验收条件；验收锚定预授权 seam，机械可判。

- **US-A1 提交生成审批链（editor/admin）**
  editor/admin 对 `draft` 合同 submit，按金额自动生成链。
  验收（S1）：① 合法 submit 成功，合同进 `in_review`，`approvals` 里出现一条 `pending` 链；② 金额 `< 100,000 元` 得 1 级链（仅 level1 admin）；③ 金额 `≥ 100,000 元` 得 2 级链（level1 admin + level2 legal）；④ 临界值 `== 100,000 元` 归 2 级；⑤ 非 draft 状态 submit → 409；给不出链的非法输入（如金额为负/非整数）→ 400；viewer submit → 403。
- **US-A2 单级通过**
  1 级链经 admin approve 后全链通过，合同进 `pending_sign`。
  验收（S2）：① admin approve 该链 → 200，链 status=approved，合同 `in_review→pending_sign`；② 留痕：该步骤记录了 approver、时点、意见；③ outbox 写入 `approval.approved`。
- **US-A3 二级通过（legal 复核）**
  2 级链须 admin→legal 依次通过才全链通过。
  验收（S2）：① admin 通过 L1 后链仍 pending、合同仍 `in_review`，outbox 先写 `approval.approved`（L1）；② legal 通过 L2 后才 `in_review→pending_sign`；③ 跳过 L1 直接 legal approve → 409（非当前步骤）；④ 步骤角色不匹配（editor 冒充当前 admin 步骤 / admin 去复核 L2 legal 步骤）→ 403。
- **US-A4 驳回回退留痕**
  任一步骤 reject → 合同回 `draft`，驳回意见留痕可查。
  验收（S2）：① 当前步骤 reject → 200，链 status=rejected（带意见），合同 `in_review→draft`；② outbox 写 `approval.rejected`；③ 重提 submit → 生成**新链**（旧 rejected 链保留为历史）；④ reject 后仍 `draft` 可被非提交人编辑再重提。
- **US-A5 权限拒绝矩阵**
  审批动作在服务端强校验，前端不可绕过。
  验收（S2/S1）：① 身份头缺失/非法 → 401 或 403，绝不落入业务分支；② **提交人不能审批自己**——同一 `X-User-Id` 再 approve 自己 → 403；③ 非当前角色 / 越权角色（viewer、无权 editor）→ 403；④ 每次写操作原子落盘，错误路径不吞异常不外泄栈。
- **US-A6 前端审批操作**
  `in_review` 合同在工作台展示审批按钮 + 意见表单 + 驳回原因，按角色与当前步骤渲染。
  验收（S4）：① 静态面可达，列表/详情对带链的合同渲染审批入口；② approve/reject 走真实 API 并留痕回显；③ 驳回原因（拒绝意见）可见；④ 按角色隐藏无权动作（viewer/非当前角色看不到可点按钮）；⑤ 前端不复制审批链/金额分级规则（交给服务端）。

## Implementation Decisions

- **审批链=数据矩阵**：金额门槛、步骤角色集、链状态机做在 shared 领域规约（纯函数 + 常量），server 与测试复用同一来源。
- **金额整数分**：阈值常量 `TWO_LEVEL_THRESHOLD_CENTS = 10_000_000`；链以提交时点 `amount` 快照，禁止浮点入存储。
- **角色矩阵扩展（偏离①）**：新增第 4 角色 **legal**，语义 = 只读 + 仅 L2 复核；`ROLE_LEVEL` 中 legal 取 read 档（与 viewer 同级，不获建/改/提交权）。`approve/reject` 不按 `ROLE_LEVEL` 数值门槛走通用 `requireLevel`，而是**精确比对当前步骤必需的 `role`**。
- **身份 seam 扩展（偏离②）**：审批留痕与"提交人不能审批自己"需要用户级标识。在既有 `X-User-Role` 之外新增 mock 头 `X-User-Id`（`id` 形如 `u_<no>`）；头缺失时提交/审批动作 401（只读 GET 仍可无 id，因权限只看角色）。`submitter_id` 记入链。真认证上线后两个头一并替换（ADR-0002 延续）。
- **存储复用（偏离③）**：approvals 与 outbox 均复用已交付 `createFileStore`（进程内单例锁 + 原子 rename 已证）。approvals 按 `id` 存链、按 `contract_id` 索引（list 扫描即可，数据量内可接受；`// ponytail: 数量到顶再加索引`）；outbox 按事件 `id` 存 append 式列表（F3 消费后标记/清空由 F3 决定，本功能只写）。
- **状态机耦合（偏离④）**：已提交过链的合同，`in_review→pending_sign` 仅经链全通过达成；`/status` 对该边 409。无链合同保留原 admin 迁移（不破坏 contract-crud）。
- **意向不可逆**：链一旦 submit 即建立，步骤通过后不可撤销（只能整体 reject 回 draft 重提）；`approved` 的链作历史存根，后续重提生成**新链**。

## Testing Decisions（只测外部行为）

- 框架 `node:test`（`node --test`），零依赖；领域/金额/权限改动必配测试（process.md）。
- **S1 链生成器 + 领域单元**：金额分级边界（<、==、> 阈值）、步骤角色集、链/步骤非纯态规约、留痕形状。
- **S2 HTTP 集成**：临时端口真实 server；submit/approve/reject 全流程、权限拒绝矩阵（US-A5）、金额/非法状态/越权三类缺陷各 ≥1（process.md 强制）。
- **S3 outbox**：三事件类型在正确时点写入 `data/outbox.json`（写而不消费）。
- **S4 前端冒烟**：静态可达 + 审批入口渲染 + approve/reject round-trip 走真实 API。
- 遗漏缺陷类别断言：错误信封统一（`{ok,data,error}`），不抛栈。

## Out of Scope

真实邮件发送（F3 消费 outbox）、会签/并行审批、委托代理、审批链模板化、`in_review` 期间主体冻结（提交后仍可编辑，金额快照抗漂移）、审批超时/催办、自动到期、approvals/outbox 容量分片与多实例索引、legal 的 CRUD/编辑权。