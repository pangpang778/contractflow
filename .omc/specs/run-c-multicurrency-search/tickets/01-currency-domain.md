# T1 币种 + 汇率域（S1, S2）
- blockedBy: []

## 目标
可构建任意 `{CNY,USD,EUR}` 合同；`toCNY` 折算纯函数；遗留合同读侧补 CNY。

## 改动
- 新增 `shared/rates.js`：
  - `export const CURRENCIES = ['CNY','USD','EUR']`；`DEFAULT_CURRENCY='CNY'`；`RATE_SCALE=1_000_000`。
  - `toCNY(amount, currency, rate)`：CNY → `amount`；外币 → `Math.floor(amount * rate / RATE_SCALE)`（整数分，向下取整）。
  - `rateFor(rates, currency)`：`rates?.rates?.[currency]` 归一元化，未提供/未知 → 1。
  - `normalizeContract(row)`：读侧补 `currency ?? 'CNY'`；返回新对象不 mutate。
- `shared/contracts.js`：
  - `validateContract`：`currency` 可选，`CURRENCIES.includes` 校验（替代单一 `=== CURRENCY`）。
  - `createContract`：`currency: input.currency ?? DEFAULT_CURRENCY`。
  - 保留 `BUSINESS_FIELDS` 含 `currency`（生效即冻结）。

## 验收（node --test）
- `validateContract({...VALID, currency:'USD'}).ok === true`；`{'XXX'}` 拒绝；缺省放行。
- `createContract({...VALID, currency:'USD'}).currency === 'USD'`；缺省 `'CNY'`。
- `toCNY(100,'USD',7200000)===720`、`toCNY(1,'USD',500000)===0`（分数分截断）、CNY 恒等、缺币种恒等。
- `normalizeContract({id,title,amount})` 补 `currency:'CNY'`，不动入参。
- 新增 `test/rates.test.js`；更新 `test/contracts.test.js` USD 由"拒绝"改"放行"。全量零回归。

## Review gate
审查：`toCNY` 整数语义无浮点、floor 方向、CURRENCIES 白名单、normalize 不可变。