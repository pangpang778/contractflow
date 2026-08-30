# ADR-0008 — CSV 批量导入（Run D）

- 日期: 2026-08-31
- 状态: accepted
- 关联: `shared/csv.js`, `shared/importer.js`, `server/app.js` (`/api/contracts/import`)

## Context
历史合同成批录入（线下台账迁入/迁移备份）。逐条表单录入不可接受。需要：固定表头、逐行容错（坏行不拖垮全批）、相对方按名自动建（避免重复录入）、编号可作为合同 id。约束：零运行时依赖，IP 匹配不启 csv 包；CSV 手写 RFC4180 状态机。

## Decision
1. **表头**（精确匹配，乱序/多余列拒绝 `400 INVALID_HEADER`）：`编号,标题,相对方名,金额(分),币种,到期日`。
2. **解析**：`shared/csv.js parseCsv(text)` RFC4180 状态机（引号内逗号/换行/转义引号、CRLF、可带 BOM）；引号未闭合等 → `{code:'BAD_CSV'}` 400。
3. **行语义**（`shared/importer.js validateImportRow`）：`编号`→合同 id（批内去重 + 对库内查重复）；`金额(分)` 非负整数；`币种` ∈ 现行枚举 + 空→`CNY`；`到期日` `YYYY-MM-DD`；title 非空。错行入 `failures[{line,reason}]` **不中断**，合法行走，全批返回 `201 {total,succeeded,failed,created_contract_ids,created_counterparty_ids,failures}`。
4. **相对方**：按名查；无则自动建（`credit_code:''`，同名复用，不重复）。`start_date`=导入当日；经一条多行批量语义——`POST /api/contracts/import` body 即 CSV 文本（`Content-Type: text`）。
5. **权限**：editor 起读写（随合同创建）。

## Consequences
- 错误可见性：行级行号报告，修复重导即可，不丢合法数据。
- 表头为契约：变更需版本演进（不兼容旧模板时 400 引导）。
- 自动相对方落库后可后续手工补 `credit_code/risk_rating`（正常相对方维护流）。

## Reversibility
可逆。换表头列是改 `IMPORT_HEADERS`；入队列/后台化为把导入从单请求拆成 job 即可，schema 不变。