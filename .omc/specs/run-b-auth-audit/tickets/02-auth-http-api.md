# T2 登录/登出端点 + requireAuth 中间件（seam S2）· ready-for-agent（C3 预授权）

`blockedBy: [01-session-domain]` — 会话域就绪后暴露 HTTP 面。
目标：把登录/登出/锁定/缺 token 变为可测的外部行为；`requireAuth` 单函数中间件成为全部路由的身份来源，既有授权点（requireLevel/ident）语义不变、路由体零改动。

## 交付切片
- **server/app.js（既有中央 server 加 addon 块，纯增量 + 身份来源替换）**：
  - `createApp` 增参 `sessions`（SessionStore 注入）。
  - **`requireAuth(sessions)`**：从 `Authorization: Bearer <token>`（大小写不敏感前缀）解析 → `sessions.validate(token)` → 会话或 null。缺头/非法/过期 → null。
  - **身份来源替换**：`roleOf(req)` 改为从 `requireAuth` 解析的会话角色派生（不再读 `X-User-Role`）；`ident(req)` 取会话 `{role, id}`（不再读 `X-User-Id`）。`requireLevel`/`ident` 签名与全部路由体不变。
  - **登录/登出路由**（在 requireLevel 之前注册）：
    - `POST /api/auth/login`：读 `{username,password}` → `sessions.login`；成功 200 `{token, role, id, expires_at}`；`UNAUTHORIZED` → 401 同 body；`LOCKED` → 423 `{code:'LOCKED', retry_after}`。
    - `POST /api/auth/logout`：`requireAuth` 解析当前 token → `sessions.revoke` → 204；无有效 token → 401。
- **错误信封统一**（`{ok,data,error}`），登录失败不泄露用户存在性。
- 客户端测试辅助：各测试 `req` 从"填 X-User-* 头"改为"登录得 token → 附 Bearer"。本票先迁移一个最小集成测试文件（如登录/登出自身），其余端点迁移归 T4。

## 验收条件（机械可判）
1. 正确凭据 → 200 含 `token`/`role`/`expires_at`（≈now+8h）。
2. 错密码、不存在用户 → 同一 401 `UNAUTHORIZED`（body 一致）。
3. 锁定 → 423 `LOCKED` 且 `retry_after≈900s`。
4. 登出携带有效 token → 204；登出后再用原 token 访问受保护端点 → 401。
5. 无 token／非法 token／过期 token 访问受保护端点 → 401，不落入业务分支。
6. **假角色头不再生效**：带 `X-User-Role: admin` 但无 Bearer → 401（读侧）；带 Bearer 的 viewer 访问写端点 → 403（角色矩阵仍生效）。
7. 逆 token（错误签名长度/未知字符）→ 401，不 500。

## 演示/验证（S2）
`node --test`：临时端口真实 server + 临时用户库/会话库；登录/登出/锁定/缺 token/假头全矩阵；错误信封统一。