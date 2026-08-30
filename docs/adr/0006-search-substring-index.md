# ADR-0006 — 全文搜索：子串倒排 + 请求时重建（Run C）

- 日期: 2026-08-30
- 状态: accepted
- 关联: `shared/search.js`, `server/app.js` (`/api/search`)

## Context
工作台只能浏览合同/相对方全表，无法按文本定位目标。需要跨合同（标题/编号/相对方名/正文）+ 相对方（名称/信用代码）的检索。约束：零运行时依赖、无 CJK 分词、无相关度排序（C4 预授权）。

## Decision
1. **纯函数倒排**：`shared/search.js` 的 `buildSearchIndex(contracts, counterparties)` 生成可查询文档快照 `{ docs:[{kind,id,updated_at,status,text(lower)}] }`；`queryIndex(index, q, {status})` 做 `text.includes(q)` 子串匹配、分组 `{contracts, counterparties}`、各自 `updated_at` 倒序。
2. **检索文本**：合同 = 标题 + id(编号) + 相对方名 + 正文首段；相对方 = 名称 + 信用代码；全部 lowercase（大小写不敏感）。
3. **重建时机**：请求时读-建-查（恒新鲜，无失效 bug）。`buildSearchIndex` 幂等。ponytail: 内部工具数据规模，每次搜索重建可接受；量大再缓存 + 写后失效。
4. **过滤叠加**：`/api/search?q&status=`，`status` 仅过滤合同结果。
5. **权限**：viewer 可读；未认证 401（沿用 `requireLevel(0)` 认证 seam）。

## Consequences
- 无词表/分词，搜索为纯子串命中；不承诺语义检索或拼音/近义（Out of Scope）。
- 恒新鲜重建牺牲了索引缓存的吞吐，换取零陈旧——符合内部工具量级与正确性优先。
- 结果为只读，不写任何存储。

## Reversibility
可逆。子串 → 分词/相关度是增量演进：扩 `buildSearchIndex` 生成 token 映射 + `queryIndex` 排序即可，API 契约 `{contracts,counterparties}` 不变。