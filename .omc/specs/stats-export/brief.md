# Mission Brief — 统计看板 + 导出 (C1)

## Objective
1. `GET /api/stats`：合同状态分布、总金额与按状态金额汇总、本月到期清单
2. `GET /api/export/report.md`：中文 Markdown 管理周报——统计表、即将到期合同明细（按天排序）、各审批链超时清单
3. 看板 UI：统计卡片（状态分布徽章 + 总金额）+ 导出按钮（新窗口打开 md）

## Scope boundary
- 统计/渲染全部纯函数（注入数据可测）；导出为 text/markdown
- 金额显示用元（除以 100），千分位

## Non-goals
图表库（用 HTML 表格 + 语义色徽章）、PDF、定时推送（F3 的 outbox 已覆盖提醒）

## Pre-approved seams（C2 预授权）
- S1 统计聚合纯函数（空库/多状态/多币种边界——当前单币种）
- S2 Markdown 渲染纯函数（表格转义：竖线/换行）
- S3 API 集成（两端点 + 权限）
- S4 看板 UI 冒烟（卡片 + 挂载点）

## Ticket 期望
2-3 张垂直切片（stats 纯函数+API 一张、渲染一张、UI 一张），共享面小可并行由拆票判断。
