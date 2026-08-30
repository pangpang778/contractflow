# T5 迁移 + 接线 + 回归（S2）
- blockedBy: [01, 02, 03, 04]

## 目标
`data/rates.json` 种子 + `index.js` 接线 + 变更单币种放开 + 全量回归。

## 改动
- 新建 `data/rates.json`：`{ "base":"CNY", "source":"manual", "updated_at":"2026-08-30", "rates":{ "USD":7200000, "EUR":7820000 } }`（e6 整数，合成值）。
- `server/index.js`：启动读 `data/rates.json`（解析失败 → `{}` 不崩服务）；`createApp({ ..., rates })`。
- `shared/amendments.js`：`validateAmendment` 的 `currency` 判断由 `!== CURRENCY` 改 `!CURRENCIES.includes(v)`（从 contracts 引 `CURRENCIES`）。
- `test/amendments.test.js`：`changes:{currency:'USD'}` 合法用例改断言放行；`{currency:'XXX'}` 拒绝。
- 全量 `node --test` 回归（期望不变——原 185 + 本 run 新增全部 GREEN）。

## 验收（node --test）
- `data/rates.json` 可被 index 加载、`toCNY`/stats 可用其值。
- amendment 可变更币种到 USD/EUR，`XXX` 仍拒。
- 全量零回归（含审计/认证套件）。

## Review gate
审查：rates.json 解析容错、amendment 白名单、index 接线不破坏既有依赖注入。