# T5 导入校验 + 报告 + 最小相对方纯函数（S5）
- blockedBy: [04]

## 目标
`shared/importer.js`：表头精确匹配、逐行字段校验、批内/库内编号唯一、最小相对方构造、报告聚合。纯函数，不做存储 IO。

## 改动
- 新增 `shared/importer.js`（ESM，纯函数；复用 `CURRENCIES`、`isValidDate` 于 shared/rates.js + contracts.js）：
  - `IMPORT_HEADERS = ['编号','标题','相对方名','金额(分)','币种','到期日']`。
  - `parseHeader(headerRow)` → `{ok:true}` 或 `{ok:false, reason}`（顺序/列名须精确）。
  - `validateImportRow(row, seenIds)` → `{ok, contract:{编号,标题,相对方名,金额,币种,到期日}, errors:[...]}`：
    - 编号：必填；`seenIds`（批内 Set）重复 → 错。
    - 标题：必填非空。相对方名：必填非空。
    - 金额(分)：必填、非负整数。
    - 币种：空 → `CNY`；非空须 `CURRENCIES` 枚举。
    - 到期日：`isValidDate`。
    - 全空行 → `{skip:true}`（可忽略）。
  - `makeImportedCounterparty(name, now, {id})` → `{id, name, credit_code:'', contact:null, risk_rating:'C', created_at, updated_at}`（与 `normalizeCounterparty` 输出形状一致，供自动建相对方）。
  - `buildImportReport(results, createdMetas)` → `{total, succeeded, failed, failures:[{line, field, reason}], created_contract_ids, created_counterparty_ids}` 骨架纯聚合。

## 验收（node --test）
- 新增 `test/importer.test.js`：表头精确/错列/缺列拒绝；逐字段（缺编号/重复编号/标题空/相对方空/金额负数/非整数/币种非法/日期非法）；空币种→CNY；全空行跳过；`makeImportedCounterparty` 形状；报告聚合计数。
- 全量 209 用例零回归。

## Review gate
审查：纯函数无存储/无 http、枚举复用 CURRENCIES、金额整数校验无浮点、编号唯一在纯层可测、报告不可 mutate 入参。