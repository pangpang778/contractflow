# Mission Brief — Run B：真认证 Session + 操作审计日志 (C1)

## Objective（两个功能，安全域）
1. **真认证 Session**：偿还 mock 身份（X-User-Role/X-User-Id 头）——替换为
   登录会话：`POST /api/auth/login`（用户名+密码，凭据存 data/users.json，
   密码 scrypt 哈希 + salt）→ 返回 session token（crypto.randomBytes 32B），
   后续请求 `Authorization: Bearer <token>`；`POST /api/auth/logout` 吊销；
   会话 8 小时过期；失败 5 次锁定 15 分钟。
   现有全部端点从 X-User-* 头迁移到 session 认证（角色不变）。
2. **操作审计日志**：data.md 已有规范（只追加）——落地实现：
   所有写操作（合同/审批/变更单/相对方/认证事件）写 `data/audit.log`
   （JSONL，只追加：{ts, actor, action, entity, entity_id, from, to, reason}）；
   `GET /api/audit?entity=&actor=&from=&to=` 查询端点（admin only）。

## Scope boundary
- 认证中间件：单函数 `requireAuth(sessionStore, role?)`，全部路由接它
- 密码哈希：node:crypto scrypt（内置，零依赖）
- 既有测试迁移：X-User-* 头测试全部改为 session 认证
- 审计写入点：在 store 层统一埋点（非 handler 散落）

## Non-goals
OAuth/SSO、密码找回、多因子、refresh token（8 小时重登可接受）

## Pre-approved seams（C2/C3 预授权——除非偏离否则直通 Phase 4）
- S1 SessionStore（纯逻辑：创建/校验/吊销/过期/锁定计数）
- S2 认证中间件 + 登录/登出端点
- S3 AuditLog 只追加写入器 + 查询过滤纯函数
- S4 全端点迁移（X-User-* → Bearer）+ 审计埋点
- S5 前端登录页 + token 存储与自动附带

## Ticket 期望
4-5 张垂直切片（认证域与审计域可部分并行）。

## C4 预授权
- 会话存储：内存 Map + 持久化 data/sessions.json（重启恢复）
- 登录失败锁定：内存计数（重启清零可接受）
- 审计日志不脱敏（内部工具，admin only 查询）
