# 合同 CRUD + 状态机 · Spec

> 依 brief（C1），seam S1–S3 已预授权。本文本 = C2 申请对象：验收条件 + test seam 列表，连同对预授权 seam 的偏离一并请人工批准。

## Problem

内部合同管理需要一套可签署、可追溯、按角色隔离的服务端基座。当前仓库仅含 harness 纸面（CLAUDE.md/CONTEXT.md/standards/tokens），无任何运行代码、无数据、无 API、无 UI。MVP 要从零立起：合同 CRUD、生命周期状态机、三档角色权限、内部工作台；且在「金额禁浮点、生效后冻结、越权服务端强校验、状态先于数据」四条规则下正确，且全程零运行时依赖。

## Solution

一个 `node:http` 服务 + 本地 JSON 存储 + vanilla 前端三面垂直切片：

- **领域层**（shared）：只放纯函数与合同领域模型——生命周期状态机矩阵与迁移规约、字段校验、金额整数语义。不透传 http / store。
- **存储层**：对外暴露可替换 Storage 接口，`data/contracts.json` 与 `data/counterparties.json`（静态种子）为 MVP 落点；整存整取 + 进程内单例锁 + 原子写。已知上限：`// ponytail: 单 JSON 文件，容量到顶再换`。
- **服务端**：`/api/contracts` CRUD + `/:id/status` 迁移 + 角色校验；统一错误信封 `{ok,data,error}`，不向客户端抛栈。
- **前端**：vanilla HTML/CSS/JS，消费服务端 JSON API，不复制业务规则；令牌来自 design-system tokens，状态色只取 `color.status`。

身份 seam：无登录系统（真认证为 non-goal），客户端以 `X-User-Role: admin|editor|viewer` 携带角色，服务端据其强制授权。真认证后续功能再替换此 seam（见 Implementation Decisions）。

### 生命周期状态机（从此矩阵出发，授权后在 CONTEXT.md 补录一次性把文字对齐）

来源：CONTEXT.md「合同生命周期」＋ tokens `color.status`（pending_sign 而非 brief 的 signed；void 为被迫终止终态）。brief 的 `approved`/`signed` 折叠为**迁移动作**而非状态（遵循 CONTEXT「状态与动作分开建模」）。

| 状态 | 含义 | 可迁出 |
|---|---|---|
| `draft` | 起草 | → in_review、→ void |
| `in_review` | 审核中 | → draft（退回）、→ pending_sign（审批通过，admin）、→ void |
| `pending_sign` | 待签署 | → active（签署）、→ void |
| `active` | 生效（主体冻结） | → archived、→ void、→ expired |
| `archived` | 归档（正常完结·终态） | — |
| `void` | 作废（被迫终止·终态） | — |
| `expired` | 到期（终态，手动触发；自动到期提醒为 non-goal） | — |

非法跳转服务端 409 拒绝；状态机矩阵为单一事实源，前端不复制。角色对迁移的授权见 Implementation Decisions 权限矩阵。

## User Stories

编号（US1–US6），各带可测验收条件；验收条件锚定预授权 seam，确保机械可判。

- **US1 只读查看（viewer）**
  成为 viewer 的用户可查看合同列表与详情。
  验收：① 该角色 GET 返回完整列表与单条详情；② 该角色任何写操作（创建/编辑/迁移）被拒绝并返回 403；③ GET 不写存储。
- **US2 新建合同（editor / admin）**
  可填写标题、相对方、金额、期限创建合同，初始态为 `draft`。
  验收：① 合法提交返回成功且 `status=draft`、获得格式合法且唯一的合同 id；② 必填缺失 → 400；③ 金额为浮点/负数/非整数分/越界 → 400；④ 日期非 `YYYY-MM-DD` 或 end<start → 400；⑤ viewer 创建 → 403。
- **US3 编辑合同（冻结语义）**
  editor/admin 在未冻结前可改可编辑字段；`active` 之后业务主体字段拒绝修改。
  验收：① 可编辑态（draft/in_review）修改成功且不可变地返回新版；② `active` 后对金额/期限/相对方/标题任一修改 → 409；③ viewer 编辑 → 403；④ 回传的状态值被服务端忽略，status 只随转移动作变（不信前端）。
- **US4 生命周期迁移**
  状态仅沿白名单迁移，越权与非法跳转被服务端拒绝。
  验收：① `draft→in_review` 成功；② 非法跳转（如 `draft→active`）→ 409 且状态不变；③ 越权迁移（editor 触发 admin-only 动作）→ 403；④ 终态无出边，对 `archived/void/expired` 再迁移 → 409；⑤ `in_review→pending_sign`（审批）为 admin-only。
- **US5 角色权限矩阵**
  三档角色在服务端统一强制，前端不可绕过。
  验收：权限矩阵每一行至少一条用例（含 身份缺失→401 或 403）全部通过（S2 角色拒绝）。
- **US6 工作台 UI**
  列表、详情、新建表单三面消费真实 API；令牌渲染；挂载点可用。
  验收：① 静态页面可达（S3 冒烟）；② 页面挂载后从 API 渲染列表/详情；③ 表单提交走 API 且遵守角色提示；④ 状态用 `color.status` 色值呈现。

## Implementation Decisions

- **状态机=数据矩阵**：迁移白名单与授权做在共享领域规约（一张表/字典），server 与测试复用同一来源；前端自然不复制。
- **金额整数分**：`amount` 为整数、单位分、`currency:"CNY"` 固定；禁止浮点入存储与运算。展示层才转元。
- **不可变写**：迁移/更新返回新对象/新版，不原地 mutate；`active` 后冻结。
- **并发与原子**：写为 read-modify-write，进程内单例锁序列化；落盘用写临时文件 + 原子 rename。`// ponytail: 单例锁，多实例/高并发再换数据库`。
- **ID 约定**：合同 `c_<epoch>-<rand>`，相对方 `cp_<...>`，前缀分域、生成后不可变（data.md）。
- **相对方解耦**：MVP 以只读静态种子 `data/counterparties.json` 承载相对方，合同持 `counterparty_id` 引用；相对方 CRUD 为非目标。
- **身份 seam（偏离）**：以 `X-User-Role` 头模拟登录身份，服务端据此授权；真认证后续替换。理由：零依赖内部工具，无登录设施，且让 S2 角色拒绝可测。
- **冻结字段集合**：`active` 后只读 = 金额、币种、期限（start/end）、相对方、标题/标的（业务主体字段）；仅 status 可经授权迁移变。
- **权限矩阵（偏离，待 C2 确认）**：

| 动作 | admin | editor | viewer |
|---|---|---|---|
| GET 列表/详情、GET 相对方 | ✔ | ✔ | ✔ |
| 新建合同 | ✔ | ✔ | ✘ 403 |
| 编辑（未冻结） | ✔ | ✔ | ✘ 403 |
| 迁移 draft→in_review / in_review→draft / pending_sign→active / active→archived | ✔ | ✔ | ✘ 403 |
| 审批 in_review→pending_sign | ✔ | ✘ 403 | ✘ 403 |
| 作废→void / 到期→expired | ✔ | ✘ 403 | ✘ 403 |
| 删除合同 / 改相对方种子 | ✔ | ✘ 403 | ✘ 403 |

## Testing Decisions（只测外部行为）

- 框架：`node:test`（`node --test`），零依赖。领域/金额/状态机/权限改动必配测试（process.md）。
- **S1 存储与状态机单元**：状态机矩阵（合法/非法跳转、终态出边、冻结后迁移只读）、CRUD、并发原子写、ID 生成唯一性、金额整数语义。
- **S2 HTTP 集成**：临时端口启动真实 server；覆盖 校验矩阵（US2）、角色拒绝矩阵（US5/US1）、金额/非法跳转三类缺陷场景各至少一条（process.md 强制）。
- **S3 前端冒烟**：静态可达 + 挂载点渲染 + 表单走真实 API。
- 遗漏缺陷类别断言：错误信封统一（`{ok,data,error}`），不抛栈。

## Out of Scope

审批工作流引擎（近似 admin 迁移动作即可）、到期提醒（expired 仅手动）、PDF 生成、电子签、看板、相对方 CRUD、真认证/SSO、变更单（amendment）、里程碑与收付款、分页与多文件分片、expired 自动触发。