# 统计看板 + 导出 Spec

> 依 brief（C1），seam S1–S4 已预授权。本文本 = **C2 申请对象**：验收条件 + test seam 列表，连同对预授权 seam 的偏离（①–⑤），一并请人工批准。
> 只读派生，无新存储、无运行时依赖、无图表库：所有统计/渲染为纯函数（`shared/`），服务端仅做计算 + 只读端点，前端做展示冒烟。金额沿用整数"分"语义（CONTEXT.md 收付款项），展示层转元并千分位。

## Problem

系统已有合同 CRUD、审批链、到期提醒三块能力，但**管理侧没有"全局视图"**：看不出合同状态分布、总金额与按状态金额、本月有哪些合同到期，也无法一键导出中文管理周报。审批链无超时可见性——存在长期 pending、无人决策的链，管理端无从感知。现状只能逐条翻合同列表，无聚合口径，也无审计友好的周报产物。

## Solution

纯派生三层（全部复用既有机械，不新增依赖/存储/真导出通道）：

- **领域层 A —— 统计聚合（`shared/stats.js`，纯函数，S1）**：输入 `contracts[] + now` → 输出 `computeStats` 结果（状态分布、总金额、按状态金额、本月到期清单）；另两个派生纯函数 `computeUpcoming`（报告用即将到期明细）与 `computeOverdueChains`（审批链超时派生）。**纯函数、时间注入可测**。
- **领域层 B —— 周报渲染（`shared/report.js`，纯函数，S2）**：`renderReport(payload)` → 中文 Markdown 字符串。统计表、即将到期明细（按天升序）、超时链清单；金额转元（分→元）+ 千分位；Markdown 表格转义（`|` / 换行）。
- **服务端接线（S3）**：两个只读端点，均 `requireLevel 0`（viewer 可读，见偏离⑤）：
  - `GET /api/stats`：返回 `computeStats` JSON（看板数据源）。
  - `GET /api/export/report.md`：`Content-Type: text/markdown`，S1 计算 → S2 渲染，返回管理周报正文（新窗口打开即导出）。
- **看板 UI（S4）**：统计卡片（状态分布徽章 + 总金额）+ 导出按钮（`window.open('/api/export/report.md')`）。非 goal 图表库——HTML 表格 + 语义色徽章。

### 数据模型

无新存储。只读 `data/contracts.json`（`store`）与 `data/approvals.json`（`approvals`，前端周报超时清单用）。合同字段：`{id, title, counterparty_id, amount: 整数分, currency, status, start_date, end_date, ...}`；审批链：`{id, contract_id, submitter_id, status, steps:[{level,role,outcome,decided_at,...}], created_at, ...}`。

## User Stories

编号（US-S1…US-S5），各带可测验收条件；锚定预授权 seam S1–S4，机械可判。

- **US-S1 统计聚合（纯函数，S1）**
  given 空库/多状态合同 + 当前时间 → 状态分布、总金额、按状态金额、本月到期清单。
  验收（S1）：① **空库** → 各状态 count=0、总金额=0、本月到期为空，不崩；② **状态分布**：`by_status` 覆盖全部 `STATES`（draft/in_review/pending_sign/active/archived/void/expired），每状态 count 正确；③ **金额整数语义**：`total_cents` = 各合同 `amount` 整数和（单位分）；`by_status_cents` 按状态独立求和，总金额 == 各状态之和（无重复/遗漏），全程无浮点；④ **本月到期清单** `ending_this_month`：`end_date` 落当前自然月内（首日…末日）且 status ∉ {archived,void,expired} 的合同，按 `end_date` 升序（见偏离②）；⑤ 输出形状稳定 `{currency, total_cents, by_status, by_status_cents, ending_this_month}`，`currency: 'CNY'`（偏离①）。
- **US-S2 报告数据派生（纯函数，S1）**
  given 合同 + 审批链 + 当前时间 → 即将到期明细 + 审批链超时清单。
  验收（S1）：① **即将到期** `computeUpcoming`：status==='active' 且 `0 ≤ (end_date − today) ≤ 30` 天的合同，按 `end_date` 升序（含当天到期；锚定既有 `REMINDER_TIERS[0]=30`，偏离③）；② **超时派生** `computeOverdueChains`：pending 链当前待决步骤等待时长 `> slaDays` 者入选；等待起点 = 首步时为 `chain.created_at`、非首步时为其前一步 `decided_at`（二级链第二步从第一步通过起计，偏离④）；③ 边界：wait == slaDays 不入、`slaDays+1` 入；④ approved/rejected 链永不入选；⑤ 每条约 `{chain_id, contract_id, title, submitter_id, level, role, waited_days}`，`waited_days` 整数。
- **US-S3 周报渲染（纯函数，S2）**
  given 计算后的 payload → 中文 Markdown 周报。
  验收（S2）：① 标题 + 生成日期；② **统计表**：Markdown 表格，行为（状态 → 合同数 → 金额），含合计行；③ **千分位**：金额元带千分位（如 `123456` 分 → `1,234.56`）；④ **表格转义**：标题含 `|` 或换行/`\n` → 导出单元格内不破表（转义或替换）；⑤ **即将到期明细**：行按 `end_date` 升序，列含标题/相对方/金额/到期日/剩余天数；⑥ **超时清单**：pending 且超 SLA 的链，行含链 id/合同/提交人/当前步骤(level+role)/等待天数；⑦ 空数据不崩、输出为合法字符串。
- **US-S4 服务端只读端点（S3）**
  `GET /api/stats`、`GET /api/export/report.md` 只读、无副作用。
  验收（S3）：① `/api/stats` 返回 `{ok:true, data: computeStats}`，viewer 可读；② `/api/export/report.md` 返回 `Content-Type: text/markdown; charset=utf-8`，body 含统计表/即将到期/超时清单三节，**不写任何存储**；③ 无 `X-User-Role` 头 → 401，绝不落入业务分支；④ 未知角色 → 401（与既有 `roleOf` 一致）；⑤ 错误统一 `{ok,data,error}` 信封、不抛栈。
- **US-S5 看板 UI 冒烟（S4）**
  卡片（状态分布徽章 + 总金额）+ 导出按钮 + 挂载点。
  验收（S4）：① 入口 HTML 含 `id="stats-cards"`、`id="export-report"` 挂载点（http 冒烟断言）；② `client/app.js` 含纯展示函数 `renderStatsCards(data)`（api/stats JSON → 卡片 HTML）与导出按钮 → `window.open('/api/export/report.md')`；③ 页面加载即请求 `/api/stats` 并渲染卡片，用既有 smoke 模式断言 app.js 引用挂载接线；④ 不复制业务规则（只展示，统计口径全在服务端）。

## Implementation Decisions

- **纯函数 × 2 模块，透传零污染**：`shared/stats.js`（S1）、`shared/report.js`（S2）均纯函数，注入 `contracts[] / chains[] / now`，不 import http/store。服务端（S3）只做读 store + 调纯函数 + 回包。
- **金额整数语义**：统计在整数分上求和，禁止浮点（既有规范）；`report.js` 才把分转元字符串（`/100`）并千分位（展示层，不做算术入存储）。前端 `money()` 既有先例但无千分位，报表用本功能自有 `formatYuan`（纯，S2）。
- **偏离① —— 单币种口径（C2 确认）**：brief S1 说"多币种边界——当前单币种"。但 repo `validateContract`（shared/contracts.js）硬性 `currency === 'CNY'`（`CURRENCY='CNY'`），多币种合同当前不可能产生。决策：`computeStats` 返回单一 `currency:'CNY'` + 标量 `total_cents / by_status_cents`，**不做 per-currency 字典**。可逆：多币种落地时再扩 per-currency keys（YAGNI，不为不可达路径预建模）。
- **偏离② —— "本月到期" 精确集合（C2 确认）**：brief objective 1 未定义"本月到期"过滤。定义 `ending_this_month` = `end_date` 落在当前自然月内（首日…末日，按本地时区）且 **status ∉ TERMINAL**（排除 archived/void/expired）的合同，按 `end_date` 升序。含 draft/in_review/pending_sign（未生效但已占期限）与 active。
- **偏离③ —— "即将到期明细" 集合（C2 确认）**：brief objective 2 未定义。定义 `computeUpcoming` = active 且 `0 ≤ days_left ≤ 30` 的合同，按 `end_date` 升序。**锚定既有 `REMINDER_TIERS[0] = 30`**（shared/reminders.js），不新造 window；仅 active（到期提醒扫描同样只关心 active）。
- **偏离④ —— 审批链"超时"语义 + SLA 常量（C2 确认）**：approval 链（shared/approvals.js）**无超时概念/字段**。新增纯函数 `computeOverdueChains(chains, now, { slaDays })`，常量 `STATS_SLA_DAYS = 7`（管理周报视角：7 天未决即超额）。超时 = 当前待决步骤等待时长 `> slaDays`；等待起点 = 首步用 `chain.created_at`、非首步用前一步 `decided_at`。阈值与计时锚点是**新业务规则**，需 C2 明示接受，可经 `slaDays` 参数调。
- **偏离⑤ —— 权限口径（C2 确认）**：导出手动触达看板，属只读信息面；两端点均 `requireLevel 0`（viewer/legal/editor/admin 可读）。与既有只读端点（/counterparties、/contracts GET）一致。无身份 → 401。若需 admin 才可见报表，C2 可改口径（改 `requireLevel` 档即可，成本低）。
- **无前端业务逻辑**：看板只把 api/stats JSON 映射为卡片 HTML（展示），统计口径、权限全在服务端（CLAUDE.md 架构原则）。无图表库：HTML 表格 + 语义色徽章（brief non-goal）。
- **排版/转义**：Markdown 表格转义（`|`→`\|`、换行→空格/`<br>`）集中在 `shared/report.js` 的 `escCell`；报表的语言随文档走中文（不建多语言抽象，YAGNI）。

## Testing Decisions（只测外部行为）

- 框架 `node:test`（`node --test`），零依赖；金额/领域改动必配测试（process.md）。
- **S1 统计单元**：空库、多状态 count 分布、total_cents 整数和、by_status_cents 求和一致性（总==各状态和）、本月到期边界（首日/末日/跨月排除/终态排除/升序）、即将到期 30 天窗口边界（0/30 入、31 出）、超时 SLA 边界（==7 不入、==8 入）、计时锚点（二级链第二步从首步 decided_at 起、首步从 created_at 起）、deterministic（now 注入）。
- **S2 渲染单元**：Markdown 统计表行/合计、千分位（123456 分→`1,234.56`）、表格转义（标题含 `|`/换行不破表）、即将到期按天升序、超时行字段、空数据不崩、输出为字符串。
- **S3 HTTP 集成**：临时端口真实 server；两端点 200 + 形状、`/api/export/report.md` Content-Type 断言 + 三节存在、只读无副作用（读 store 前后一致/不新增文件）、viewer 可读、无身份头→401、未知角色→401、错误信封。三缺陷类别（越权/非法入参/空库）各 ≥1。
- **S4 UI 冒烟（http 断言，沿用 smoke.test.js 模式）**：`/` HTML 含 `id="stats-cards"`、`id="export-report"`；`/app.js` 含 `renderStatsCards`、`/api/stats`、`/api/export/report.md`。看板卡片渲染为纯 `renderStatsCards(data)`，可独立断言给定 fixture 的输出含徽章 + 金额。
- 回归：全仓 `node --test` 绿（approval-flow / approvals / contracts / reminders / http / smoke 既有用例）。

## Out of Scope

图表库/可视化（HTML 表格 + 语义色徽章）、PDF、定时推送（outbox/消费已覆盖提醒）、可交互筛选/下钻/分页、多币种实际数据（当前 validateContract 强制 CNY）、真实导出通道/下载附件（新窗口打开 markdown）、报表语言多语言支持、"超时"阈值管理界面（SLA 常量，后续可配置化）、opened chain 驱动合同状态的一致性审计（workflow 已管）。