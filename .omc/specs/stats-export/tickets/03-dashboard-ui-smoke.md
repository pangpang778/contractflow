# T3 看板 UI 冒烟（seam S4）· 候选 (待 C3 批准)

`blockedBy: [T2]` — 依赖 T2 的真实 `GET /api/stats` 与 `/api/export/report.md` 端点做冒烟。
目标：把"状态分布徽章 + 总金额卡片"和"导出按钮"挂到工作台，可被 http 冒烟断言；仅展示，不复制规则。
状态：ready-for-agent（C2+C3 已批后生效）。

## 交付切片（跨面但单点演示）
- **client/index.html**：在 `main#app` 顶部加看板区：
  - `section.panel > id="stats-cards"`（状态分布徽章 + 总金额卡片的挂载点）。
  - 导出按钮 `button id="export-report"`（文案"导出周报"）。
- **client/app.js**（沿用既有 `money`/`esc`/`badge` 模式，纯展示）：
  - `renderStatsCards(data)`：`api/stats` JSON → 卡片 HTML 字符串（状态徽章 `status-<state>` 复用既有语义色 + 各状态合同数；总金额用 `formatYuan` 千分位）。**只把服务端算好的 `by_status` / `total_cents` 映射为展示，不复算统计口径。**
  - 页面加载（`init()`）即 `api('/api/stats')` → `renderStatsCards` 写入 `#stats-cards`；失败进 `flash` 不崩。
  - 导出按钮：`window.open('/api/export/report.md')`（新窗口打开 markdown）。
- **测试**：在 `test/smoke.test.js`（或独立 `test/stats-ui.test.js`）加 S4 冒烟，沿用既有 http 断言模式：
  - `GET /` HTML 含 `id="stats-cards"`、`id="export-report"`；
  - `GET /app.js` 含 `renderStatsCards`、`/api/stats`、`/api/export/report.md`；
  - 必要时对 `renderStatsCards`（导出为可测纯函数）给定 fixture 断言输出含徽章 + 千分位金额。

## 验收条件（机械可判）
1. `/` HTML 含 `id="stats-cards"`、`id="export-report"` 挂载点。
2. `/app.js` 含 `renderStatsCards`、`/api/stats` 请求、导出 `window.open('/api/export/report.md')`。
3. `renderStatsCards(fixture)`：状态徽章 + 各状态 count + 千分位总金额（如 `123456`→`1,234.56`）；空/缺数据不崩。
4. 看板只展示，不复制统计/权限规则（统计口径全在服务端 T1/T2）。
5. 回归：`node --test` 全仓绿。

## 演示/验证（S4）
http 冒烟断言挂载点 + 接线引用；`renderStatsCards` 若导出则单测断言输出。既有 smoke 模式，无需浏览器运行时。