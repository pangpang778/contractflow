# T2 折算 + 统计接入（S1）
- blockedBy: [01]

## 目标
看板统计按折算后 CNY 汇总，出口带汇率来源留痕。

## 改动
- `shared/stats.js`：
  - `computeStats(contracts, now, { rates } = {})`：每合同 `const cur = c.currency ?? 'CNY'`；非 CNY 且 `rateFor(rates,cur)` → `toCNY(amount,cur,rate)`；缺率 → 恒等。计入 `total_cents / by_status_cents`。
  - 返回追加 `rates_used`：本轮实际使用的非 CNY 币种→rate 映射（全 CNY → `{}`）；`currency` 仍 `'CNY'`（兼容既有断言）。
- `server/app.js` `/api/stats`：透传 `rates`（从 createApp 注入，缺省 undefined）→ `computeStats(rows, now, { rates })`。

## 验收（node --test）
- `computeStats([USD 100.00], now, {rates:{USD:7200000}}).total_cents === 72000`；`rates_used.USD === 7200000`。
- `computeStats([CNY...], now)` 全 CNY：`total_cents` 恒等、`rates_used` 为 `{}`、`currency==='CNY'`。
- `/api/stats` 透传汇率后 viewer 200、数据含 `rates_used`。
- 更新 `test/stats.test.js` 增折算用例 + `test/stats-api.test.js` 增 `rates_used` 断言；既有 stats 用例零回归。

## Review gate
审查：折算只发生在非 CNY；`rates_used` 无损叠加；既有断言 `currency:'CNY'` 未破坏。