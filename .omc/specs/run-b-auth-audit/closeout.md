# Run B 完成报告（C5）

日期：2026-08-30。状态：C5 出具。分支 `feat/run-b-auth-audit`（未提交，遵指示）。
规格：`.omc/specs/run-b-auth-audit/spec.md`；5 张工票全部 terminal。

## 交付范围
1. **T1 会话域**（`server/auth.js`）：scrypt+盐 密码哈希、`timingSafeEqual` 常数时间比较、32B 随机 token、8h TTL、同用户名 5 失败锁 15 分钟（内存）、`sessions.json` 持久化重启恢复。
2. **T2 认证 HTTP API**（`server/app.js` seam S2）：`POST /api/auth/login`（200 token/role/expires_at；401 统一、423 锁定）、`POST /api/auth/logout`（204 吊销）；`requireLevel`/`ident` 身份改读 Bearer 会话，路由体零改动。
3. **T3 操作审计**（`server/audit.js` seam S4）：JSONL 只追加（O_APPEND+单例锁）、AsyncLocalStorage actor 注入、存储包装层 `withAudit`、admin-only `GET /api/audit` 过滤查询；fail-close 写入。
4. **T4 全端点迁移 + 审计埋点**（`server/index.js` + dev seed；8 个既有测试文件迁移）：各端点写路径全审计；四角色 dev 用户库；全部遗留 X-User-* 头测试改 Bearer session。
5. **T5 前端登录页**（`client/index.html` + `app.js` + `app.css` seam S5）：登录表单、localStorage `{token,role,id,expires_at}`、`api()` 附 `Authorization: Bearer`、401→清 token 回登录、登出调 `/api/auth/logout` 清 token、角色取自会话。

## 验证证据
- `node --test`：**185/185 GREEN**（基线 161 → Run B 新增审计 8 + 认证 14 + 迁移回归 + fail-closed 角色回归 1）。
- 每票独立 review gate（实施者不自批）：T1 PASS、T3 PASS（H-1 修复后）、T4 PASS（两 H 修复后）、T5 PASS（H/M/L 修复后）。

## 纸面痕迹
- 术语/决策：`CONTEXT.md`（认证 ADR-0003 + 审计日志节）。ADR：`docs/adr/0001–0004`（新增 0004 审计）。
- 工票：`.omc/specs/run-b-auth-audit/tickets/01–05`。教训：`docs/dogfood/findings.json`（Run B 增 CF-004~006）。

## 决策日志（load-bearing，可回溯）
| 决策 | 记录位置 |
|---|---|
| 身份来源 = Bearer 会话，授权决策点不变 | ADR-0003 |
| 密码 scrypt+盐 + timingSafeEqual；会话 8h/锁 15min/持久化 | ADR-0003 #2 |
| 审计 = 只追加 JSONL + fail-close + AsyncLocalStorage actor | ADR-0004 |
| 审计写失败 → 写路径 5xx、认证事件 catch 可观测 | ADR-0004 #4（CF-004） |
| "未知角色/缺字段" 用例在原子 token 下塌缩为"缺/坏 token" | spec/testing（CF-005） |
| 前端 token 落 localStorage（部署接 cookie 为后置） | ADR-0003 权衡 |

## Open Assumptions（按人类最可能否决概率排序）
1. **对称式时序比较**（T1 review MEDIUM）：登录时对未知用户名仍执行一次 dummy 哈希，抵消用户存在性时序差异——本实现保留了占位 dummy，未做满对称（reviewer 结论 PASS + 2 条跟进，未 in-flight 修）。若威胁模型把"用户枚举"当硬边界，需补对称。**否决概率：中。**
2. **失败计数 Map 无上限**（T1 review MEDIUM）：`failed[username]` 内存 Map 不设上限，长期间谍式失败会无界增长。同锁定时限（重启清零）；极端滥用下可 OOM 前先压满单用户名 5 次上限。小额加固可后期加 cap。**否决概率：低。**
3. **锁定内存承载、重启清零**：简单换取零持久化失败状态成本；锁不是账户级策略，只是临时防爆破。生产要持久锁定需换方案。**否决概率：低（内部工具）。**
4. **dev 口令默认 `contractflow-dev`** 明文落 `server/index.js`（`CF_DEV_PASSWORD` 可覆写）。仅 dev seed；生产用户库不写默认值。**否决概率：低。**
5. **审计 actor = 会话 userId**（非实名展示）：审计可信任性依赖 ADR-0003 真认证；UI 显示 id 而非姓名。若合规要实名，需用户名映射展示层。**否决概率：低。**
6. **token 明文落前端 localStorage**：ADR-0003 明示部署强化（HttpOnly cookie / KMS）留后置。**否决概率：低。**

## 未做
- git commit/push（遵指示，由人定）。
- `run-c-multicurrency-search/` 目录非 Run B 产物，未触碰。