# Run C Spec — 多币种 + 全文搜索

## Problem
1. **单币种锁定**：合同 `currency` 被 `shared/contracts.js` 硬编码为 `CURRENCY='CNY'`——`validateContract` 拒绝一切非 CNY，`createContract` 恒写 CNY。真实合同横跨外币（USD/EUR），统计 `computeStats` 只做原始分数求和、返回固定 `currency:'CNY'`，无法按折算后口径汇总，也无法追溯汇率来源。
2. **无检索**：工作台只能浏览合同/相对方全表，无法按文本定位。检索能力缺失，用户需翻页人工找目标。

## Solution
1. **多币种**：合同 `currency` 放开为 ISO 4217 子集 `{CNY,USD,EUR}`（默认 CNY）。新增 `shared/rates.js` 纯函数域：
   - `toCNY(amount, currency, rate)`——整数分运算，方向**向下取整分**（C4 预授权）；CNY 恒等，外币 `floor(amount × rate / RATE_SCALE)`。
   - `RATE_SCALE = 1_000_000`（micro-CNY/单位）；`rateFor(rates, currency)` 归一查询，CNY/缺币种 → 1。
   - 汇率表 `data/rates.json` 手工维护，形状 `{ base:'CNY', source, updated_at, rates:{USD:6位e6整数,EUR:...} }`。
   - 旧合同读路径补 `currency:'CNY'`（C4 预授权：不迁移内容只补字段），`normalizeContract` 读侧归一。
   - `computeStats(contracts, now, { rates })` 按 `c.currency ?? 'CNY'` 折算求和，返回仍 `currency:'CNY'`（所有非基币一律折算到 CNY），附加 `rates_used` 作汇率来源留痕。
2. **全文搜索**：`GET /api/search?q=<text>&status=<opt>`——跨合同（标题/编号=id/相对方名/正文首段=description）+ 相对方（名称/信用代码），大小写不敏感子串匹配、无分词（C4 预授权）、按更新时间倒序，结果分组 `{contracts, counterparties}`；`status` 过滤叠加（S4）。纯函数倒排：`shared/search.js` 的 `buildSearchIndex(contracts, counterparties)` 生成可查询文档快照（重建幂等），`queryIndex(index, q, status)` 分组匹配。

## User Stories
- **US-C1**（T1）构建 USD 合同：`validateContract({...VALID, currency:'USD'}).ok === true`，`createContract(...)` 落 `currency:'USD'`；缺省 → `'CNY'`；`currency:'XXX'` 拒绝。
- **US-C2**（T2）看板折算：一条 USD 100.00（rate 7.2）合同，`computeStats` 的 `total_cents` 计入 72000；`rates_used` 含 `USD:7200000`；全 CNY 仓返回 `currency:'CNY'` 且 `total_cents` 与折算前一致（零回归）。
- **US-C3**（T2）`toCNY` 精度：`toCNY(100, 'USD', 7200000)` → 720（1 USD × 7.2 = 7.20 CNY = 720 分）向下取整分；分数分截断 `toCNY(1, 'USD', 500000)` → 0（rate 0.5 下 $0.01 → 0.5 分 → 截断 0）。
- **US-C4**（T3）子串搜索：q 命中合同标题/相对方名/正文、相对方名/信用代码，大小写不敏感；结果按 kind 分组、各内按 `updated_at` 倒序。
- **US-C5**（T3）过滤叠加：`/api/search?q=x&status=active` 仅返回 active 合同；viewer 可读，未认证 401。
- **US-C6**（T5）旧数据补字段：无 `currency` 的遗留行经 `normalizeContract` / 统计读侧视为 CNY，内容不迁移。
- **US-C7**（S5/T4）UI：新建合同表单有币种下拉（CNY/USD/EUR）；列表与详情展示币种；顶部搜索框跨类型检索并分组展示结果。

## Implementation Decisions
- 金额恒整数分 + 汇率 e6 micro 整数——全程无浮点（延续架构原则）。
- `toCNY` 折算只读、无副作用；`date` 参数不参与数学（汇率表为当前快照，无历史汇率/生效日期），仅预留溯源位。
- `computeStats` 第三参 `rates` 可缺省（缺省 = 仅 CNY / 恒等），兼容既有调用与测试零回归。
- 搜索按请求时重建索引（读-建-查），恒新鲜、无失效 bug；`buildSearchIndex` 幂等。ponytail: 数据规模内部工具级，每次搜索重建可接受；量大再缓存+写后失效。
- 未知外币（有合同但 rates.json 无该币种）按 rate=1 折算（视同 CNY），记为 Open Assumption。

## Testing Decisions（外部行为）
- 纯函数单测：`test/rates.test.js`（toCNY 恒等/外币/向下取整/缺币种）、`test/search.test.js`（索引构建/重建幂等/子串/分组/排序/过滤、搜索 API 认证与状态码由 api 套件覆盖）。
- API 集成：`test/search-api.test.js`——`/api/search` viewer 200 / 未认证 401 / 无结果分组空 / status 过滤叠加。
- 回归更新（行为放开）：`contracts.test.js` USD 校验用例与 `amendments.test.js` currency 用例随之放行；`stats.test.js` 增折算用例；全部既有 185 用例零回归。
- 全程 `node --test`。

## Out of Scope
外部汇率 API、CJK 分词、相关度排序、汇率历史/生效日期、UI 搜索防抖/自动补全。