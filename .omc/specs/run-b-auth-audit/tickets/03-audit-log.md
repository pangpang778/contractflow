# T3 审计日志：只追加写入器 + 查询过滤 + admin 端点（seam S3）· ready-for-agent（C3 预授权）

`blockedBy: [02-auth-http-api]` — 查询端点需 requireAuth；审计域纯逻辑本身不依赖认证，但端点挂在同一 server 上串行最稳。
目标：把"只追加 JSONL 写入 + 过滤查询 + admin-only 端点"落地为可测行为；写路径埋点（withAudit + AsyncLocalStorage actor）在此建立，作为 T4 收敛全部写径的基础。

## 交付切片
- **server/audit.js（新模块，审计域）**：
  - `createAuditWriter(file)`：只追加 JSONL 写入器——`append(record)` 追加一行（原子 append，并发两写不截断）；`list()` 读全行解析为数组。
  - `queryAudit(records, {entity, actor, from, to})`：纯函数过滤——按 entity 相等、actor 相等、`from<=ts<=to`（ISO 比较）过滤，ts 降序返回；无过滤参数则全量。
  - `withAudit(store, { entity, audit, requestCtx })`：包装 create/update/remove——逐个写操作追一条记录 `{ts, actor, action, entity, entity_id, from, to, reason}`；actor 读 `requestCtx.getStore()`（缺→`'system'`）；`action=entity.create|update|remove`；from/to 为变更字段最小差异（状态迁移即旧/新 status，reason=`status <from>→<to>`）。
  - `requestCtx` = `AsyncLocalStorage`（node:async_hooks 内置，零依赖），导出供 app.js 与存储包装共用。
- **server/app.js（纯增量）**：
  - `createApp` 增参 `audit`（写入器）+ 可选 `sessions`（已有）。
  - 每请求在认证解析后以 `requestCtx.run({ id, role }, ...)` 包裹（actor 注入；静态/未认证请求为无 store）。
  - 对四类存储（contract/approval/amendment/counterparty）经 `withAudit` 包装后再交路由；auth 事件路由单独 `audit.append(auth.*)`。
  - **`GET /api/audit?entity=&actor=&from=&to=`**：admin only——`requireLevel(res, req, 2)` → `queryAudit(await audit.list(), params)` → 200。viewer → 403，缺 token → 401。

## 验收条件（机械可判）
1. `append` 落一行合法 JSONL；重复 append 不覆盖既有行。
2. 并发两 append 不互相截断（Promise.all 两个 append 后 `list()` 恰两条完整行）。
3. `queryAudit` 按 entity/actor/time-range 过滤正确；无参数返回全量且 ts 降序；组合参数交集。
4. `withAudit.create`（给 `requestCtx.run` 包 actor 后调用）产生一条含 actor/entity/entity_id 的记录；无 ctx → actor='system'。
5. `withAudit.update` 的 from/to = 变更字段最小差异（改 status → from={status:旧} to={status:新} reason=`status 旧→新`）。
6. `GET /api/audit`：admin 200 回过滤结果；viewer 403；缺 token 401；filters 分组正确。
7. 认证事件记录：登录成功/失败/登出 → `auth.login`/`auth.login_failed`/`auth.logout`（actor 合理）。

## 演示/验证（S3）
`node --test`：临时端口真实 server + 临时审计文件；写入器/过滤纯函数矩阵 + admin/viewer/缺身份对端点 + 认证事件。