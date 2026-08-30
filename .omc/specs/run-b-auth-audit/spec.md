# 真认证 Session + 操作审计日志 · Spec

> 依 brief（C1），seams S1–S5 已预授权；C4 既答（会话内存 Map + 持久化 `sessions.json` 重启恢复；登录失败内存计数重启清零；审计不脱敏 admin-only 查询；金额/权限/状态机改动必配测试——process.md）。C2/C3 同样预授权直通 Phase 4，故本文本即 C2/C3 申请对象：验收条件 + test seam 列表 + Phase 3 拆票依据，并在 Solution 内落地执行中涌现决策的推荐解。文档语言中文，契约表述（不写文件路径与行号）——唯一例外：既定语料（`scrypt`、`sessions.json`、`audit.log`）为 brief 原始契约，随 spec 落盘。

## Problem

当前所有端点的身份建立在 mock 头上：客户端自报 `X-User-Role` + `X-User-Id`，服务端据此强制授权（ADR-0002）。任何人一个 curl 就能伪造 admin——这不是"内部信任"，是把授权决策交给了不可信的调用方。同时全系统没有任何操作留痕：谁在何时改了什么合同、推了哪张审批、删了哪个相对方，一概不可追溯。对一个合同系统（法律证据载体）而言，审计缺失是合规层面的硬伤。

需要：①真实登录会话取代 mock 头——用户以用户名+密码登录，服务端签发作废 8 小时有效的会话 token，请求改持 `Authorization: Bearer <token>`；密码以 scrypt+盐哈希落盘；失败 5 次锁定 15 分钟。②操作审计——所有写操作（合同/变更单/相对方/审批/认证事件）以只追加 JSONL 写入，admin 可经查询端点检索。

## Solution

两个域——认证域（Session/登录）与审计域（AuditLog）——域逻辑各自纯、可控、可测；认证域先立（它是一切授权与审计 actor 的来源），审计域与登录端点可部分并行，最后一张票全端点迁移 + 埋点收敛 + 前端登录页。

- **认证域（server 侧新模块，`requireAuth` 单函数中间件）**：
  - 凭据存用户库（用户名 → `{id, username, role, password_hash, salt}`）。密码 scrypt 哈希 + 随机盐，验证用 `timingSafeEqual` 常数时间比较；哈希成本参数可注入（生产高成本，测试低成本，避免测试 40ms×N 拖慢套件）。
  - `POST /api/auth/login`：用户名+密码 → 成功签发会话（token = 32B 随机 hex，返回 `{token, role, id, expires_at}`）；失败记一次登录失败，同一用户名连续 5 次失败锁定 15 分钟（锁定态在内存，重启清零，C4 既答）；用户名不存在与密码错误返回同一 401（防枚举）。
  - 会话有效期 8 小时（自创建起，固定时长），过期由校验时惰性删除；刷新不做（non-goal，brief 明确可接受重登）。
  - `POST /api/auth/logout`：吊销当前 token。
  - **`requireAuth(sessionStore, role?)`**：从 `Authorization: Bearer <token>` 解析会话 → 返回 `{id, role}` 或 null；作为既有 `requireLevel`/`ident` 的身份来源，全部路由经它，路由体零改动（断言：`roleOf`/`ident` 改读会话，`X-User-*` 头完全不再读取）。角色矩阵（viewer/editor/admin）不变。
- **审计域（server 侧新模块）**：只追加 JSONL 写入器 + 查询过滤纯函数。
  - 记录形 `{ts, actor, action, entity, entity_id, from, to, reason}`；`from`/`to` 为变更字段的旧值/新值（最小差异，状态迁移即旧/新 status），`reason` 默认空（状态迁移时记 `status <from>→<to>`）。
  - 写入集中在**存储包装层**（非 handler 散落，brief scope 边界）：写操作经 `withAudit` 包装合同/审批/变更单/相对方四类存储的 create/update/remove，逐个写操作追一条审计行；认证事件（登录成功/失败/登出）单独记 `auth.*`。actor 来自请求上下文——每请求在认证解析后以 `AsyncLocalStorage` 注入当前 `{id, role}`，存储包装据此写 actor（无 actor 的下游系统写 `system`）。
  - `GET /api/audit?entity=&actor=&from=&to=`：admin only，先过滤（本迭代只过滤不分页，内部量级足够，见 Out of Scope），ts 降序返回。
- **凭证与启动**：启动时若无用户库则用 dev seed 建 admin/editor/viewer 三档用户（scrypt 哈希落盘），供开发即刻登录；会话库持久化到 `sessions.json`，重启加载未过期会话恢复在线（C4 既答）。
- **前端**：登录页（用户名/密码 → token 存 localStorage），后续请求自动附 `Authorization: Bearer`；登出清 token；未登录访问工作台 → 跳登录。

### 会话状态机（S1 纯逻辑，单一事实源）

| 环节 | 输入 | 输出 | 备注 |
|---|---|---|---|
| login 成功 | 用户名+正确密码 | 创建会话 `{token,userId,role,createdAt,expiresAt}` | 重置该用户名失败计数；持久化 |
| login 失败 | 用户名+错密码 | 401；失败计数+1 | 计数 ∈ 内存；≥5 → 置 lockedUntil=now+15min |
| login 失败(锁定) | 用户名+任意密码 | 423 `LOCKED` + retry_after | 锁定期间一律拒绝 |
| validate | token | 会话/或 null | 过有效期或已吊销 → null，惰性删除 |
| revoke | token | 删除会话 | logout / 主动吊销 |

## User Stories（各带可测验收条件；验收锚定预授权 seam）

- **US1 会话存储（S1）**：创建/校验/吊销/过期/锁定计数纯逻辑。
  验收：① 登录成功返回 8h 内过期的 token，`validate(token)` 还原 `{id, role}`；② 过期 token → 校验 null 且被清；③ 吊销后 → null；④ 连续 5 次错密码 → 第 5 次起 423 锁定（retry_after≈15min），正确密码也拒绝；⑤ 成功登录重置失败计数；⑥ 会话持久化：重建 SessionStore（同文件）后未过期会话仍可 validate。
- **US2 登录/登出端点 + requireAuth（S2）**：HTTP 面承认证。
  验收：① 正确凭据 → 200 含 token/role/expires_at；② 错密码/不存在用户 → 同一 401 UNAUTHORIZED；③ 锁定 → 423；④ logout 后原 token 再请求 → 401；⑤ 无/非法 Bearer → 401，不落入业务分支；⑥ 缺 token 访问受保护端点 → 401，带假角色头但无 token 仍 401（`X-User-*` 不再被读取）。
- **US3 审计写入 + 查询（S3）**：只追加写入器 + 过滤纯函数 + admin 查询端点。
  验收：① 写操作（合同创建）落一条 JSONL，含 actor/entity/entity_id/ts 且追加不改既有行；② 追加原子：并发两写不互相覆盖（无截断）；③ `queryAudit` 按 entity/actor/时间区间过滤正确；④ `GET /api/audit` admin 200、viewer 403、缺 token 401；⑤ 过滤参数组合正确返回。
- **US4 全端点迁移 + 审计埋点（S4）**：既有全部端点改 session 认证，写路径全审计。
  验收：① 既有角色矩阵测试（读/建/改/删/审批/迁移）改以 Bearer token 驱动，全部通过——viewer 只读、editor 建改、admin 删批、缺身份 401 语义不变；② 客户端不再发送 `X-User-*`；③ 合同/审批/变更单/相对方的每个写操作产生对应审计行；④ 认证事件（登录成功/失败/登出）落审计。
- **US5 前端登录 + token 附带（S5）**：登录页 + 持久化 + 自动附和登出。
  验收：① 工作台静态含登录表单布局；② 登录成功后 token 存前端、后续请求带 `Authorization: Bearer`、无 `X-User-*`；③ 登出清除 token 并回登录；④ 未登录访问工作台 → 登录态提示/跳转；⑤ 页面挂载后经真实 API（登录→取数）冒烟。

## Implementation Decisions（含执行中涌现决策的推荐解）

- **部门边界：认证/审计逻辑放 server 侧新模块，不进 shared/**。两域是基础设施/安全边界实现，不是合同领域纯函数；shared 只放合同/变更单/相对方/审批/统计/提醒领域。`requireAuth`、`SessionStore`、`AuditLog`、`withAudit`、`requestCtx` 均落 server 侧。纯函数（session 判定、锁判定、审计过滤）在测试中直接 import 即可。**（涌现决策，按 brief C4 推荐解执行。）
- **`requireLevel`/`ident` 签名不变，身份来源改读会话**：现有全部路由体（数十处调用）零改动，只替换 `roleOf`/`ident` 的实现——"服务端授权点不变、只换身份来源"的最小落地。`roleOf` 从 `requireAuth` 解析的角色派生，`ident` 取会话 `{role,id}`。**不再读 `X-User-Role`/`X-User-Id`**。
- **actor 经 `AsyncLocalStorage` 注入**：认证解析成功后请求上下文放 `{id, role}`，存储包装层写审计时读取。零依赖（node:async_hooks 内置），一处注入、处处可取，避免 actor 从每个 handler 透传（与"store 层统一埋点、非 handler 散落"约束一致）。
- **审计写操作粒度 = 存储 create/update/remove**：合同/审批/变更单/相对方各包一层 `withAudit`，逐个写操作一条审计行。审批 submit/approve/reject 是 approval 存储的 create/update，变更单 apply 落 amendment + contract 两存储写，均被捕获。from/to 为变更字段最小差异。**理由**：散落 handler 埋点会漏旁路（派生的适用、夜间消费器），包存储一次收敛全部写径。
- **认证事件单独在 login/logout 路由记 `auth.*`**：登录成功记 `auth.login`、失败记 `auth.login_failed`、登出记 `auth.logout`；actor=当事用户（失败时未验证，记 `unknown`）。
- **scrypt 哈希成本可注入**：默认生产成本，测试注入低成本——既真实验证 scrypt 往返（哈希+盐+timingSafeEqual），又不让多测试文件每秒吞 40ms。
- **用户库 dev seed**：启动缺用户库则建 admin/editor/viewer 三档（明文密码 admin/editor/viewer，落盘为 scrypt 哈希）。**`// ponytail: dev 种子，正式上线换真实开户。`** 测试自建临时用户库，不依赖 seed。
- **锁定状态内存承载（C4 既答）**：重启清零；会话持久化只为重启恢复在线，不持久化失败计数。
- **token localStorage 明文存储可接受**：内部工具，机器横越防护留部署（`// ponytail: 正式部署接 HttpOnly cookie 或 KMS`）。

## Testing Decisions（只测外部行为，`node:test` 零依赖）

- **S1 会话域单元**：登录成功/失败/锁定边界/过期/吊销/持久化恢复、scrypt 往返、常数时间验证同一哈希结果。金额无关但权限与锁定为安全路径——失败锁定边界、越权 401/403、非法（无 token）至少各一。
- **S2 登录端点集成**：临时端口真实 server + 临时用户库/会话库；登录/登出/锁定/缺 token/假角色头仍 401 全矩阵；错误信封统一。
- **S3 审计域单元 + 端点集成**：追加原子性（并发写不覆盖）、过滤纯函数矩阵、admin/viewer/缺身份对 `GET /api/audit` 的 401/403/200。
- **S4 全链路迁移回归**：既有 API 测试文件（合同/审批/相对方/变更单/统计/提醒/冒烟/superseded）全部改以登录→Bearer 驱动，角色矩阵语义不变；顺带断言 `X-User-*` 头不再生效、写路径审计行产生。
- **S5 前端冒烟**：静态可达、登录表单挂载、登录后 JS 自带 Bearer 且无 `X-User-*`、登出逻辑、真实 API 登录→取数链路。

## Out of Scope

- OAuth/SSO、密码找回、多因子、refresh token（brief non-goals，8h 重登可接受）。
- 审计事后不可变归档/导出、大文件轮转（仅追加 JSONL，内部量级足够；`// ponytail: 文件到 ~10MB 或并发争用再评估`，对齐 data.md 规模约束）。
- 审计脱敏/字段级过滤（brief C4 既答：admin-only 查询、不脱敏）。
- CSRF/HSTS 等浏览器安全头强化（网络层安全留待部署票）。