# Mission Brief — Run A：变更单 + 相对方管理 (C1)

## Objective（两个功能，一个 spec）
1. **变更单 Amendment**：签署/生效后的合同主体内容不可原地改（CLAUDE.md 原则兑现）——变更走"变更单"实体：引用原合同、记录变更字段（新旧值对照）、生效时继承原合同并版本号+1（v1→v2）、原合同转 superseded 并保留指针。变更单需走审批（复用 Run B 前的现有 admin 审批：amendment.draft → amendment.approved）。
2. **相对方管理 Counterparty**：相对方独立实体 CRUD（名称/统一社会信用代码/联系人/风险评级 D-R），合同创建/编辑时从相对方库选择引用；重名+同信用代码去重提示。

## Scope boundary
- Amendment：新实体（amendments.json 存储）、amendment 状态机（draft→in_review→approved→applied/superseded... 沿用既有审批链机制）、原合同 superseded 指针
- Counterparty：独立存储（data/counterparties.json）、CRUD API、去重校验（同信用代码唯一）、合同表单引用下拉
- 两者共用既有：审批链机制（Run B 前用 admin 直批）、角色矩阵、tokens

## Non-goals
- amendment 的 PDF 重新生成（打印视图 Run E）
- 相对方风险评估的 AI 化
- 跨仓合同变更（仅单仓内）

## Pre-approved seams（C2/C3 预授权——除非偏离否则直通 Phase 4）
- S1 AmendmentStore + 状态机纯函数（继承/版本链/指针）
- S2 CounterpartyStore + 去重纯函数
- S3 API：/api/amendments CRUD+apply、/api/counterparties CRUD（含角色矩阵）
- S4 UI：变更单详情+新旧对照视图、相对方管理页+选择器
- S5 既有合同表单改造（引用 counterparty_id）

## Ticket 期望
5-6 张垂直切片（域模型→API→UI），变更单与相对方可并行（文件面不相交）。

## C4 预授权（执行中涌现的同类决策按此处理，不再等待）
- 版本号格式：v1 起始、每次 applied +1
- superseded 合同在列表中默认隐藏（可筛选显示）
- 风险评级枚举：D-R 五档，默认 C
