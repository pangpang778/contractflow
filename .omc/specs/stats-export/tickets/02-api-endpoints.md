# T2 服务端只读端点（seam S3）· 候选 (待 C3 批准)

`blockedBy: [T1]` — 依赖 T1 的 `shared/stats.js` + `shared/report.js` 纯规约，做 store-bound 只读端点；这是本功能的 integration-wiring 收口。
目标：把"读 contracts/approvals → S1 计算 → S2 渲染→ 只读回包"暴露为 `GET /api/stats` 与 `GET /api/export/report.md`，无副作用。
状态：ready-for-agent（C2+C3 已批后生效）。

## 交付切片（跨面但单点演示）
- **server/app.js 新增两个只读端点**（均 `requireLevel 0`，viewer/legal/editor/admin 可读，偏离⑤；无身份/未知角色 → 401）：
  - `GET /api/stats`：返回 `sendJson(res, 200, computeStats(await store.list(), new Date()))`。仅 `store`，无需 approvals。
  - `GET /api/export/report.md`：组装 `payload`（`computeStats` + `computeUpcoming` + `computeOverdueChains` + `generated_at`）→ `renderReport(payload)`；以 `Content-Type: text/markdown; charset=utf-8` 直接回字符串（**不做 attachment**，新窗口内联打开）。读 `store` + `approvals`（`approvals` 已由 `createApp` 注入）。
  - 两端点都不写任何存储（纯只读，读-算-回包）。
- **server/index.js**：无改动（`approvals`/`store` 已注入 `createApp`）。回包缺 approvals 时 `GET /api/export/report.md` 以空链处理（`overdue=[]`），不 500。
- **测试**：`test/stats-api.test.js`（S3 HTTP 集成，临时端口真实 server）：两端点 200 + 形状、`/api/export/report.md` Content-Type + 三节、只读无副作用（读库前后文件数/内容不变）、viewer 可读、无身份头→401、未知角色→401、错误信封。三缺陷类别（越权/空库/非法入参）各 ≥1。

## 验收条件（机械可判）
1. `GET /api/stats`：`{ok:true, data:{currency,total_cents,by_status,by_status_cents,ending_this_month}}`；viewer 200。
2. `GET /api/export/report.md`：`Content-Type: text/markdown; charset=utf-8`；body 依次含统计表、即将到期明细、超时清单三节；不写存储。
3. 无 `X-User-Role` → 两端 401；未知角色 → 401；绝不落入业务分支。
4. 错误统一 `{ok,data,error}` 信封、不抛栈；approvals 未接线时 report 返回空超时清单而非 500。
5. 回归：`node --test` 全仓绿（T1 的 stats/report 单元 + 既有 approval/crud/reminder/http/smoke）。

## 演示/验证（S3）
`node --test test/stats-api.test.js` 集成冒烟 + 全仓 `node --test` 回归；临时端口真实 server，脚本打两端点验证只读与三节产出。