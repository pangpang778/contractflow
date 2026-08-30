# ADR-0003: 真认证 Session 取代 mock 身份头

日期：2026-08-30。状态：C2/C3 预授权直通（Run B）。
影响面：server 授权、全部 API 测试、前端登录。取代 ADR-0002 的身份来源（保留其权限矩阵）。

## 背景
ADR-0002 定 mock 头（`X-User-Role`/`X-User-Id`）为身份 seam，标注"真认证上线时替换，服务端授权点不变"。Run B 落地这一替换：真实登录会话 + 操作审计。审计还需要可靠的 actor 来源——mock 头可被伪造，不能作为审计记录的凭据，这强化了必须上真认证的理由。

## 决策
1. **身份来源 = Bearer 会话**：`POST /api/auth/login`（用户名+密码）签发随机 32B token（hex），客户端后续持 `Authorization: Bearer <token>`；`requireAuth(sessionStore, role?)` 单函数中间件解析会话，作为既有 `requireLevel`/`ident` 的身份来源。`X-User-*` 头完全不再读取。**授权决策点不变**（仍在服务端 `requireLevel`/`ident`），只是"谁在调用"从自报头换成服务端可验证的会话。
2. **密码**：scrypt 哈希 + 随机盐，`timingSafeEqual` 常数时间比较；哈希成本可注入（生产高、测试低）。会话 8h 过期（自创建）；同用户名连续 5 失败锁 15 分钟（内存，重启清零）；会话持久化到 `sessions.json` 重启恢复在线。
3. **审计**：写操作经存储包装层埋点（`withAudit`），actor 经 `AsyncLocalStorage` 注入；记录只追加 JSONL，admin-only 经 `GET /api/audit` 查询。审计可信任性依赖真认证提供的 actor。

## 权衡
- 失败影响：token 明文落 `sessions.json` + 前端 localStorage。内部网络部署下可接受（`// ponytail: 正式部署接 HttpOnly cookie 或 KMS`）。锁定内存承载（重启清零）以换取零持久化失败状态的简单性——重登成本低。
- 备选：保持 mock 头——审计不可信、任何请求可伪 admin，否决。

## 替代方案
- JWT 无状态会话 —— 需额外零依赖实现签名/校验，且吊销需黑名单；有状态内存 Map + 持久化更简单、便于 C4 既答的"重启恢复在线"。否决 JWT。
- HttpOnly cookie 会话 —— 前端更安全但后端需 Set-Cookie 解析 CSRF 面；本迭代朝 token+Bearer 的简单方向，cookie 留部署强化（Out of Scope）。