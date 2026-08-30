# ADR-0005 — 多币种 + 汇率折算（Run C）

- 日期: 2026-08-30
- 状态: accepted
- 关联: `shared/rates.js`, `shared/contracts.js` (币种白名单), `shared/stats.js` (折算汇总), `data/rates.json`

## Context
合同金额此前被锁定为单一 `CNY`（`shared/contracts.js` 的 `CURRENCY='CNY'`），统计只做原始分数求和。真实合同横跨 USD/EUR，看板无法按折算后口径汇总，也无法回答"外币合同在人民币基准下值多少"。

## Decision
1. **币种白名单**：`CURRENCIES = ['CNY','USD','EUR']`，默认 `CNY`。`contract.currency` 为冻结业务字段（生效后只读，改动走变更单）。
2. **折算纯函数** `toCNY(amount, currency, rate)`：整数分运算、**向下取整分**（floor，C4 预授权）；CNY 恒等；外币 `floor(amount × rate / RATE_SCALE)`。量纲验证：`amount` 为外币分（fen），1 单位外币 = 100 fen，故 `CNY分 = fen × (micro/单位) × 单位/100 × 100 / 1e6 = fen × rate / 1e6`（`/100` 与联立换算中的 ×100 相消，`100 fen @ 7.2 = 720` 分）。
3. **汇率表示**：`RATE_SCALE = 1_000_000`（micro-CNY/单位），`data/rates.json` 手维护 `rates:{USD:7200000, EUR:7820000}`。无外部 API、无历史汇率/生效日期（当前快照）。
4. **旧合同迁移**：读路径补 `currency:'CNY'`（C4 预授权：不迁移内容只补字段），`normalizeContract` 读侧归一，不落盘回写。
5. **统计折算**：`computeStats(..., { rates })` 对非 CNY 合同按 `toCNY` 折算入账；出口仍 `currency:'CNY'` + 附加 `rates_used`（汇率来源留痕，供审计追溯）。

## Consequences
- 放开了此前 `validateContract` 对非 CNY 的硬拒：`currency:'USD'|'EUR'` 现合法；`XXX` 仍拒（正向行为变化，回归用例相应更新）。
- 变更单 `change currency` 现允许 USD/EUR（shared/amendments.js 白名单同步放开）。
- 未知外币缺率按 rate=1（视同 CNY）折算——记为 Open Assumption，内部工具可接受。
- 折算只发生在统计/展示边界，存储恒为原币整数分，不改写原值。

## Reversibility
可逆。若需精确汇率历史或如期初/期末折算，仅扩 `data/rates.json` 结构 + `toCNY` 增加生效日期匹配，不影响存储形态与既有调用。