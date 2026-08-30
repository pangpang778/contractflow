# T4 全端点迁移 + 审计埋点收敛（seam S4）· ready-for-agent（C3 预授权）

`blockedBy: [02-auth-http-api, 03-audit-log]` — 认证中间件与审计写入器就绪后全局落地。
目标：既有全部端点从 X-User-* 迁移到 Bearer 会话；四类存储写路径全审计；dev seed 用户库；auth 事件审计接线；把既有测试全套改为登录→Bearer 驱动并回归。

## 交付切片
- **server/index.js（启动接线）**：创建用户库 SessionStore（含会话持久化 `sessions.json`）、审计写入器（`audit.log`）；缺用户库则 dev seed admin/editor/viewer 三档（`// ponytail: dev 种子，正式上线换真实开户`）；把四个真 store 经 `withAudit` 包装后注入 `createApp`。
- **server/app.js（既有 addon 收敛）**：确认 S2 的 `requireAuth` 无 `X-User-*` 读取、S3 的四类存储均已 `withAudit` 包裹；auth 事件（登录成功/失败/登出）在 login/logout 路由 `audit.append(auth.*)`，actor 取会话/`unknown`。写操作 audit 记录 actor=会话用户。
- **全部既有测试迁移（8 文件：合同/审批/相对方/变更单/统计/提醒/冒烟/superseded）**：测试 `req` 辅助从"填 X-User-* 头"改为——(a) setup 建临时用户库（三档用户，低成本 scrypt）；(b) 登录得 token；(c) 请求附 `Authorization: Bearer <token>`。角色矩阵语义不变：viewer 只读/editor 建改/admin 删批/缺 token 401。
- **前端客户端随迁**：`client/app.js` 的 `api()` 改持 Bearer（该 UI 层随迁为 05 的输入态——本票可先把客户端 header 从 X-User-* 换成 Bearer 占位，登录页由 05 补齐）。
- **未登录回归安全**：所有受保护读/写端点缺 token → 401 语义保持。

## 验收条件（机械可判）
1. 既有 8 个 API 测试文件全绿（登录→Bearer 驱动），每一角色矩阵行为（读/建/改/删/审批/迁移/冻结/终态/越权）语义不变。
2. `X-User-*` 头不再生效：带假角色头无 token → 401（已由 S2 断言，此处回归）。
3. 四类存储每个写操作产生 audit 行：合同 create/patch/status/delete、审批 submit/approve/reject、相对方 create/patch/delete、变更单 create/submit/approve/reject/apply 各 ≥1 条，actor 正确。
4. 认证事件落审计：登录成功/失败/登出各 ≥1 条。
5. dev seed：空数据目录启动后有 admin/editor/viewer 三档可登录（scrypt 哈希落盘，无明文密码文件）。
6. 会话持久化：登录后进程级重建（同文件 SessionStore）未过期会话仍 validate（S1 已证，此处经接线确认）。

## 演示/验证（S4）
`node --test` 全套回归；新增一条"写路径审计行"集成断言（登录→建合同→查 `/api/audit` 见 `contract.create`）。