# Mission Brief — 到期提醒 + 通知消费 (C1)

## Objective
1. **到期提醒扫描器**：给定全部 active 合同 + 当前时间 → 计算应提醒清单（到期前 30/7/1 天三档，档位不重复提醒——同一合同同档只发一次，靠 sent-key 去重）
2. **outbox 消费者**：把 outbox 中 pending 事件（审批/approval.requested 等）+ 新产生的到期提醒，渲染成中文邮件（模板：主题+正文，变量来自事件载荷），写入已发送队列并标记 sent；渲染失败 → failed + retry_count+1（≤3 次退避）
3. `GET /api/reminders/due`（当前应提醒清单）、`GET /api/outbox`（消费视图：pending/sent/failed 分组）

## Scope boundary
- 提醒/模板渲染全部**纯函数**（时间注入可测）；消费者**不真发邮件**——只记录 rendered 内容与状态（投递通道 F4 后评估）
- 中文模板（跟文档语言）

## Non-goals
真实 SMTP 发送、cron 守护进程调度器（由外部触发调用）、多语言模板

## Pre-approved seams（C2 预授权）
- S1 提醒扫描纯函数（边界：无到期日/已过期/当天到期/已提醒去重）
- S2 模板渲染纯函数（变量替换/缺变量容错/HTML 转义）
- S3 outbox 消费状态机（pending→sent/failed，retry_count 退避）
- S4 API 集成（两个端点 + outbox 分组视图）

## Ticket 期望
3 张串行垂直切片（共享 data/ 存储面）。
