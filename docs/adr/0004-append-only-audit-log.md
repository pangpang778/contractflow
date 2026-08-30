# ADR-0004: 只追加操作审计日志（JSONL + fail-close 埋点）

日期：2026-08-30。状态：C2/C3 预授权直通（Run B）。
影响面：server 写路径、认证事件、前端 API（actor 来源依赖 ADR-0003）。

## 背景
合同系统是法律证据载体，任何"谁在何时改了哪个合同"都必须可追溯。ADR-0002 的 mock 头可被伪造，不能作为审计 actor 的凭据——这正是 ADR-0003 上真认证的动因之一。本篇记录审计**记录格式与写入语义**，与身份来源（ADR-0003）正交。

## 决策
1. **只追加 JSONL 单文件**：每条 `{ts, actor, action, entity, entity_id, from, to, reason}` 一行 JSON，`appendFile` O_APPEND + 单例 promise 锁（并发 append 不互截）。查询 `queryAudit` 为纯函数过滤（entity/actor/from/to，ts 降序），admin-only 经 `GET /api/audit`。`// ponytail: 单文件，~10MB 或并发争用再轮转`。
2. **actor = AsyncLocalStorage 注入**：createServer 回调内 `requestCtx.run(actor 会话)`；缺会话 → 'system'。来源可信（ADR-0003 会话），非自报头。
3. **埋点集中存储包装层（`withAudit`）**：create/update/remove 在存储包装处逐条审计，不散落 handler——所有写路径天然收敛一处，杜绝漏埋。
4. **fail-close 写入**：`withAudit` 内 `await audit.append`，审计写失败 → 业务请求 5xx（业务数据已落盘、响应诚实报错），绝不悬空 promise（防无声丢审计 + 崩进程）。认证事件（登录成功/失败/锁定/登出）为低敏感操作，走 `.catch(console.error)` 不阻断登录，仍可观测。
5. **from/to = 变更字段最小差异**：只记变化的键（不含相等项）；`status` 迁移追加 `reason: "status draft→in_review"`。from/to 是留痕不是版本还原（后者归变更单/合同版本链）。

## 权衡
- fail-close 令审计盘故障时业务写接口 500（业务已提交）。对"不可丢失的审计"是正确取舍；若后续业务要解耦，可退化为旁路队列 + 高水位告警（当前 JSONL 单文件极简，不值得）。
- 影响面仅写路径；读接口不审计（查询无状态副作用）。GET 只读不改数据，符合监管关注"变更"的界定。

## 替代方案
- DB 表 + JOIN 查询 —— 零依赖原则下否决；JSONL 单文件 + 内存过滤在当前规模足够。
- 审计失败静默吞掉 —— 否决：审计是控制面，静默丢弃等于没有审计。