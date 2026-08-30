# Mission Brief — Run C：多币种 + 全文搜索 (C1)

## Objective（两个功能，数据能力域）
1. **多币种支持**：合同增加币种字段（currency，ISO 4217：CNY/USD/EUR，默认 CNY）+
   汇率表（data/rates.json，手工录入）+ 折算纯函数（`toCNY(amount, currency, rate, date)`，
   精度：Decimal 语义整数运算）；统计看板按折算后金额汇总；审计记录汇率来源。
2. **全文搜索**：`GET /api/search?q=<text>`——跨合同（标题/编号/相对方名/正文首段）+
   相对方（名称/信用代码）大小写不敏感子串匹配；与既有过滤叠加；结果分组返回；
   纯函数倒排实现（零依赖，重建时机=写操作后懒重建）。

## Scope boundary
- 币种折算纯函数放 packages 式 shared/（跟 core 惯例）
- 汇率表无外部 API（手工维护 JSON）
- 搜索为子串匹配（无分词/无相关度排序——按更新时间倒序）

## Non-goals
外部汇率 API、CJK 分词、搜索引擎依赖

## Pre-approved seams（C2/C3 预授权——除非偏离直通 Phase 4）
- S1 汇率表存储 + 折算纯函数（精度边界：整数分运算，四舍五入方向固定）
- S2 币种字段迁移（既有合同默认 CNY）
- S3 倒排索引构建纯函数（重建幂等）
- S4 搜索 API + 结果分组
- S5 UI：合同表单币种下拉 + 搜索框

## Ticket 期望
4-5 张：T1 币种+汇率域、T2 折算+统计接入、T3 倒排索引+搜索 API、T4 UI、T5 迁移+回归。
C4 预授权：汇率精度损失方向=向下取整分；旧合同币种=CNY 不迁移内容只补字段。

# Mission Brief — Run D：Webhook 推送 + CSV 批量导入 (C1)

## Objective（两个功能，集成域）
1. **Webhook 事件推送**：合同/审批/变更单的关键事件对外推送——
   `POST <客户配置的 URL>`，HMAC-SHA256 签名头（`X-ContractFlow-Signature`），
   指数退避重试 3 次 → 死信；管理端点配置 webhook URL（CRUD）+ 测试发送。
2. **CSV 批量导入**：`POST /api/contracts/import`（CSV 文本，表头映射固定：
   编号/标题/相对方名/金额(分)/币种/到期日）——逐行校验，错误行进报告（不中断整批），
   导入报告 JSON 返回（成功数/失败行+原因）；相对方不存在自动创建。

## Scope boundary
- Webhook：出站投递器为纯函数可测（fetch 注入）；签名 = HMAC(secret, timestamp + body)
- CSV：RFC 4180 解析（引号/逗号/换行——手写解析器，零依赖）；表头必须精确匹配
- 导入校验：金额必须非负整数分、币种在枚举内、到期日 ISO 格式；违规行进错误报告

## Non-goals
入站 webhook（只出不进）、CSV 导出（report.md 已覆盖）、webhook 事件订阅过滤

## Pre-approved seams
- S1 HMAC 签名纯函数
- S2 webhook 投递器（fetch 注入 + 退避纯逻辑）
- S3 webhook URL 管理 CRUD
- S4 RFC4180 CSV 解析纯函数（引号/转义/换行边界全覆盖）
- S5 导入校验+报告纯函数
- S6 导入 API + 报告端点

## Ticket 期望
5-6 张：webhook 域（签名/投递/管理）与 CSV 域（解析/校验导入）文件面不相交可并行。
C4 预授权：webhook secret 存 data/webhooks.json 明文（内网工具）；重试间隔 1s/5s/25s。

# Mission Brief — Run E：仪表盘 v2 + 打印视图 (C1)

## Objective（两个功能，呈现域）
1. **仪表盘 v2**：SVG 趋势图（零依赖：月度签署量/金额折线，纯函数生成 SVG path）+
   审批链耗时 Top5 表格 + 状态流转桑基简表（纯 HTML/CSS 列表即可）
2. **合同打印视图**：`GET /contracts/:id/print`——打印优化 CSS（@media print）+
   审批单导出（审批链完整留痕表格）——浏览器打印即 PDF

## Scope boundary
- SVG 由纯函数从数据生成（无图表库）；打印 CSS 独立文件
- 数据来自既有 /api/stats 与 store

## Non-goals
图表库依赖、服务端 PDF 渲染、水印

## Pre-approved seams
- S1 SVG path 生成纯函数（折线/坐标轴/标签）
- S2 打印视图渲染（模板纯函数）
- S3 打印 CSS（@media print 独立文件）
- S4 UI 接线（看板页签 + 打印入口）

## Ticket 期望
3-4 张：T1 SVG 生成器+测试、T2 仪表盘 v2 接线、T3 打印视图+CSS、T4 e2e 冒烟。
C4 预授权：图表时间粒度=月；SVG viewBox 固定 800×300。
