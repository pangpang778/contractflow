# T6 导入 API + 报告端点 + 相对方自动创建（S6）
- blockedBy: [05]

## 目标
`POST /api/contracts/import`（CSV 文本，editor+）：解析→逐行校验→合法行建合同+按名自动建相对方（批内同名复用），违规行入报告不中断整批。

## 改动
- `server/app.js`：
  - 新增 `readRawBody(req)`（累积 chunks 返回字符串，非 JSON 路径；沿用既有错误信封）。
  - 路由 `POST /api/contracts/import`（`requireLevel(1)`，editor+）：
    1. `parseCsv` → `BAD_CSV` → 400；`parseHeader` 不匹配 → 400（`INVALID_HEADER`）。
    2. 预取 `store.list()` 建 `existingIds` Set、`cpStore.list()` 建 `name→id` 映射；批内 `seenIds` Set 供校验。
    3. 对每行 `validateImportRow`（传 `seenIds`）：`skip` 忽略；出错 → 记 `{line, field, reason}`；合法 → 建相对方（改名未见则 `makeImportedCounterparty` 写入一次，批内复用 id）、`toContractInput`（`id=编号`、`currency` 空→CNY、`end_date=到期日`、`start_date=导入当日 ISO`、`counterparty_id` 解析后，其余默认）→ `store.create`。
       - `store.create` 撞 CONFLICT（编号库内重复并发）→ 该行进 `failures`，不中断。
    4. 响应 201 `buildImportReport`（`{total, succeeded, failed, failures, created_contract_ids, created_counterparty_ids}`）。
  - 建合同走既有 `createContract`（保字段校验与默认），金额/币种/日期不变异入参。
- `test/import-api.test.js`：成功建 2 合同（USD 价 + CNY 缺币种）+ 自动建相对方；同批两行同名相对方只建一个且共用 id；错误行（坏金额/非法币种/坏日期/编号重复）入失败报告、合法行不受影响（batch 不中断）；表头不匹配 400；`BAD_CSV`（未闭合引号）400；viewer 403；既有合同 `id=编号` 可经 search/详情查回。

## 验收（node --test）
- 上述路径通过；全量 209+ 用例零回归。

## Review gate
审查：任何单行错误不抛 500 中断整批、相对方自动建只写一次且批内复用、编号不可建数据库内重复 id、金额恒整数分、报告行号 human 可读、viewer 403、无 console.log。