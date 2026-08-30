# T5 合同面：superseded 列表 + 表单引用相对方库（seam S5）· ready-for-agent（C3 预授权）

`blockedBy: [02-counterparty-http-api]` — 需真实相对方库 API 供表单消费。
目标：兑现 C4「superseded 默认隐藏可筛选」，并把既有合同表单的相对方选择从硬编码改为相对方库。

## 交付切片（跨面但单点演示）
- **列表隐藏 superseded（读侧，勿动既有 7 态语义）**：既有合同列表接口默认排除 `superseded:true` 合同；`?include_superseded=1` 时含入（供历史/版本检视）。筛选只发生在读路径，不写存储。
- **统计/提醒不双计（读侧守卫）**：统计（computeStats 调用前置）与到期提醒（computeDueReminders 调用前置）在读入合同数组时排除 superseded，杜绝 v1 与继任 v2 对同一主体重复计数/重复提醒。此守卫不修改既有纯函数签名，只过滤入参。
- **表单消费相对方库（前端改造）**：既有合同新建/编辑的相对方下拉 options 来自真实相对方库（`GET /api/counterparties`），选项含名称 + 信用代码 + 风险提示（去歧义）；提交 `counterparty_id` 必须为库内存在 id。
- **引用校验入服务端**：合同创建/更新时校验 `counterparty_id` 存在于相对方库；不存在 → 400（不信前端提交）。
- **对照视图数据源**：若某合同是继任版本，读详情可获 `parent_contract_id`/`version`（供 S4 前端渲染版本链），不改既有合同返回结构之外的事。

## 验收条件（机械可判）
1. 列表：无 superseded 行时与现状一致；存在时默认不含、`?include_superseded=1` 含；参数不影响断点读。
2. 统计/提醒：superseded v1 不计入、继任 v2 计入（人工构造 superseded 档断言不双计）。
3. 表单：相对方 options 来自真实库（含信用代码/风险）；提交不存在 `counterparty_id` → 400；合法 id → 201。
4. 引用校验：合同创建/更新时 `counterparty_id` 未在库 → 400。
5. 读路径改动零副作用：对新合同（无 superseded/version）与现状行为一致。
6. 金额/越权/非法跳转中与本票相关者：无新缺陷面（相对方引用校验为输入校验）。

## 演示/验证（S5）
`node --test`：列表隐藏/含入、统计与提醒不双计、表单引用校验端到端通过。