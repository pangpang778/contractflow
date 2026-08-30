# T3 倒排索引 + 搜索 API（S3, S4）
- blockedBy: [01]

## 目标
`GET /api/search?q=<text>&status=<opt>` 跨合同+相对方子串搜索、分组、过滤叠加。

## 改动
- 新增 `shared/search.js`（纯函数）：
  - `buildSearchIndex(contracts, counterparties)` → `{ docs: [{kind:'contract'|'counterparty', id, updated_at, currency, status, text(lower)}] }`。contract 文本 = 标题 + id + 相对方名 + 正文首段(lower)；counterparty 文本 = 名称 + 信用代码(lower)。重建幂等（同输入同输出结构）。
  - `queryIndex(index, q, { status })`：q lower，`text.includes(q)` 过滤；`status` 仅作用于 contract 行过滤；分组 `{ contracts, counterparties }`、各自 `updated_at` 倒序。
- `server/app.js`：
  - 新增路由 `/api/search`：`requireLevel(0)`（viewer 可读）；`q` 必填否则 400；实时 `store.list()` + `cpStore.list()` 建索引→查询（读-建-查，恒新鲜）。contract 结果经 `normalizeContract` 归一。响应 `{ok,data:{contracts,counterparties}}`。未认证 401。

## 验收（node --test）
- 新增 `test/search.test.js`：索引构建、重建幂等、子串大小写不敏感、标题/相对方名/正文/信用代码命中、分组、`updated_at` 倒序、status 过滤。
- 新增 `test/search-api.test.js`：`/api/search?q=` viewer 200 分组非空；缺 q → 400；未认证 `q` → 401；`status=active` 过滤。
- 全量零回归。

## Review gate
审查：查询只做 lower+includes（无分词）、分组与排序正确、currency 归一在文档构建处、无存储写。