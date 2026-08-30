# T5 前端登录页 + token 存储/附带/登出（seam S5）· ready-for-agent（C3 预授权）

`blockedBy: [04-endpoint-migration-audit-instrument]` — 服务端 Bearer 就绪后接 UI。
目标：登录页 + token 持久化（localStorage）+ 自动附 `Authorization: Bearer` + 登出清 token，替代前端 X-User-* 角色下拉。

## 交付切片
- **前端（vanilla HTML/CSS/JS，无构建）**：
  - **登录视图**：用户名+密码表单（`#login-form`），提交 → `POST /api/auth/login` → 成功存 `{token, role, id}` 到 `localStorage` 并切到工作台；失败/锁定显示错误（不泄露用户存在性）。
  - **工作台**：初始无 token → 显登录视图；有 token → 进工作台。`api()` 改为附 `Authorization: Bearer <token>`（移除 `X-User-*`）；401 响应 → 清 token 回登录。
  - **登出**：调用 `POST /api/auth/logout` → 清 localStorage → 回登录。
  - **角色来源**：当前角色改从登录返回的 `role`（不再依赖前端下拉）；审批面板显隐据 session role 判定（服务端仍强校验）。
- **client 对应元素保留/新增**，与既有 `#app` 挂载点共存；`data-role` 只读隐写沿用。
- **冒烟断言**：登录表单挂载、登录后 `/app.js` 含 `Authorization`/`Bearer` 与 `/api/auth/login`、不再含 `X-User-Id`。

## 验收条件（机械可判）
1. 静态 `/` 返回含 `#login-form`（用户名/密码输入）与工作台挂载点。
2. 登录成功：`/app.js` 含 `localStorage` token 存取、`api()` 附 `Authorization: Bearer`、不再含 `X-User-Id`/`X-User-Role`。
3. 401 处理：`api()` 收到 401 → 清 token 回登录视图。
4. 登出调用 `/api/auth/logout` 并清 token。
5. 真实 API 链路冒烟：登录 → 带 Bearer 取合同列表 → 200（服务端已由 T2 保证，此处 UI 走通）。
6. 未登录访问工作台 → 显示登录视图（不崩溃、不空跑业务请求）。

## 演示/验证（S5）
`node --test`：静态可达 + 登录表单挂载断言；更新冒烟文件原来的 `X-User-Id` 断言为 `Authorization`（顺带完成 T4 的冒烟迁移）。