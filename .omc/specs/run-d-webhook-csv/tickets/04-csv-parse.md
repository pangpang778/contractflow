# T4 RFC4180 CSV 解析纯函数（S4）
- blockedBy: []

## 目标
`shared/csv.js` 零依赖 RFC4180 解析纯函数。独立于 webhook 域，可并行。

## 改动
- 新增 `shared/csv.js`（ESM，纯函数）：
  - `parseCsv(text)` → `{ header: [...strings], rows: [[...strings], ...] }`。RFC 4180：
    - 记录以 CRLF（兼容裸 LF）分隔；字段以逗号分隔。
    - 字段可用双引号包裹：包裹字段内可含逗号/CR/LF；`""` → 字面 `"`（转义）；引号包裹字段两侧不可有裸分隔符粘连异常。
    - 右引号后只允许出现分隔符或记录结束；未闭合引号 → 抛 `{code:'BAD_CSV', message}`。
    - 全空记录（空行）跳过。
  - 纯手写状态机（逐字符：IN_FIELD / IN_QUOTE / AFTER_QUOTE），无正则替代、无依赖。

## 验收（node --test）
- 新增 `test/csv.test.js` 全覆盖边界：普通行、引号字段内逗号、`""` 转义、引号字段内换行、CRLF、末位空字段、全空行跳过、未闭合引号抛 `BAD_CSV`、header+rows 切分形状。
- 全量 209 用例零回归（纯新文件，不触既有）。

## Review gate
审查：状态机三态正确、引号转义/右引号越界/未闭合分支全覆盖、无正则或正则仅兜底、纯函数无 IO。