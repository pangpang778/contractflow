# Run C Closeout — 多币种 + 全文搜索

- 状态: **已交付（C5 认证）**
- 日期: 2026-08-30
- 分支: `feat/run-c-multicurrency-search`（未 commit/push，按指令）
- 验收: `node --test` 全量 **209 pass / 0 fail**（Run B 基线 185 + Run C 新增/更新 24）

## 交付范围（对照 spec 五张票）
| Ticket | 内容 | 交付 |
|---|---|---|
| T1 | 币种+汇率域 `shared/rates.js`、`contracts/amendments` 白名单、旧数据读侧归一 | ✔ |
| T2 | 统计折算：`computeStats(...,{rates})` 折算 CNY 分 + `rates_used` 留痕 | ✔ |
| T3 | 全文搜索：`shared/search.js` 纯函数 + `GET /api/search?q=&status=` | ✔ |
| T4 | UI：币种下拉/列表/详情列 + 搜索面板分组结果 | ✔ |
| T5 | 迁移回归：既有 185 用例零回归 | ✔（max 209，0 fail） |

## 验证证据
- **自动化**：`node --test` 209/209。新增套件：`test/rates.test.js`（5）、`test/search.test.js`（7）、`test/search-api.test.js`（5）；扩展 `stats.test.js`（折算 4）、`stats-api.test.js`（折算 + 周报折算 2）。
- **独立 Review gate（non-self-approve）**：oh-my-claudecode:code-reviewer 审全部 10 改动文件 → **APPROVE-WITH-NITS**（0 CRITICAL / 0 HIGH）。
- **实机启动 smoke**：`node server/index.js` 首启登录签发 Bearer、`/api/stats` 返回 `rates_used:{}`、`/api/search` 200——验证 `data/rates.json` 经真实 boot 装载。

## 交付中修复的缺陷（超出票内、由验证/Review 发现）
1. **stats 折算失效（自研 bug）**：`computeStats` 初稿忽略第三参 `{rates}` 且引用函数外 `rates` → 外币恒回退 1。改为经 `rateFor` 接线；并确立 **fallback=1 = "视同 CNY 恒等"**（非微汇率折算）。
2. **report.md 漏传 rates（Review MEDIUM）**：`/api/export/report.md` 调用 `computeStats` 未传 `{rates}`，外币周报按原币累计、低于看板。已修复并对齐口径 + 回归测试锁死。
3. **auth 首启崩溃（Run B 潜在缺陷）**：`scrypt N=1<<17` 超出 Node 默认 `maxmem`(32MiB)，空库首启 `ensureUsers` 崩溃。`scryptSync` 显式 `maxmem=256MiB`（安全档位不变）修。
4. **toCNY 哨兵脚枪（Review LOW）**：`rate <= 1` 恒等兜底，防把外币静默折算成近 0。

## 币种/搜索要点
- `toCNY(amount,currency,rate)` = `floor(amount×rate/RATE_SCALE)`，`RATE_SCALE=1e6`（micro-CNY/单位），`amount` 为外币分。量纲验证：`100 fen USD @ 7.2 → 720 fen`。
- 未知外币缺率 → rate 1（视同 CNY），Open Assumption。
- 搜索纯函数读-建-查恒新鲜，子串大小写不敏感、无分词、按 `updated_at` 倒序、`status` 只滤合同、分组 `{contracts,counterparties}`。

## Paper trail
- Spec: `.omc/specs/run-c-multicurrency-search/spec.md`
- Tickets（5 张依赖序）: `.omc/specs/run-c-multicurrency-search/tickets/`
- ADR: `docs/adr/0005-multicurrency-conversion.md`、`docs/adr/0006-search-substring-index.md`
- 术语: `CONTEXT.md`（币种/汇率、全文搜索 新增）

## 文档勘误（关键）
初稿 spec/ticket/ADR 的 `toCNY` 公式误写 `/(100×RATE_SCALE)` 与其自身验收值 `720` 矛盾（`/100` 得 7）。已全量改 `floor(amount×rate/RATE_SCALE)`，实现与验收值、`US-C2`(100.00→72000) 一致；`US-C3` floor 示例改用财务正确值 `toCNY(1,'USD',500000)===0`。

## Open Assumptions / 后续
- 未知外币视同 CNY 折算（rate=1）；汇率表为手维护当前快照，无历史/生效日期（ADR 可逆：扩表结构即可）。
- 搜索按请求重建索引（内部工具级规模可接受）；量大再写后失效+缓存。
- 超出 2^53 的大额外币 `toCNY` 浮点（≈1 万亿分以上）——Review 实证千亿级内零偏差，未走 BigInt。