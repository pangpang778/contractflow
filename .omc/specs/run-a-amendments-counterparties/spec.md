# 变更单 + 相对方管理 · Spec

> 依 brief（C1），seam S1–S5 已预授权；C4 既答（版本号 v1 起始每次 applied +1；superseded 默认隐藏可筛选；风险评级 D-R 五档默认 C）。同样预授权 C2/C3 直通 Phase 4，故本文本 = C2 申请对象（验收条件 + test seam 列表 + 执行中涌现决策的推荐解），并在 Solution 内一并给出 Phase 3 的拆票依据。文档语言中文，契约（非坐标）表述，不写文件路径与行号。

## Problem

CLAUDE.md 原则「签署/生效后的合同主体内容只读冻结、变更走变更单」尚未落地：`active` 后合同只能改备注，改金额/期限/相对方被 409 FROZEN 拒绝，却没有合规的变更通道；相对方目前是静态种子（仅 `id`+`name` 两字段、服务启动时内存直读、只读、无 CRUD、无统一社会信用代码/联系人/风险评级、无去重），合同表单只能从固定两项里选。需要一个可追溯的变更单载体，把「改失效主体字段」变成合法、可审批、版本化的动作；并把相对方升级为可管理、可去重的独立实体。

## Solution

三个面——变更单域、相对方域、既有合同面收敛——两域可并行文件面分离，最后一张接线票收敛：

- **变更单域（shared/amendments.js 纯函数）**：校验（必填 reason、`changes` 非空且键 ⊆ 合同业务主体字段）、状态机（`draft → in_review → approved → applied`，`in_review → rejected`）、apply 纯函数。apply 以父合同主体字段为基线，仅覆盖 `changes` 声明的字段，生成**继任合同 v2**：`status` 继承为 `active`（父已签署）、`version = 父.version + 1`（老合同无 version 视为 1）、`parent_contract_id` 回指父合同；父合同标 `superseded: true` + `superseded_by`（指 v2）。**superseded 用合同布尔字段表达，不新增 STATUS**（避免波及既有状态机/角色矩阵/徽标/统计——见 Implementation Decisions）。变更单 `applied` 后幂等终止，不可二次 apply，落 `resulting_contract_id`。
- **相对方域（shared/counterparties.js 纯函数 + CounterpartyStore）**：统一社会信用代码全库唯一；重名+同码判重。字段：名称（必填）、统一社会信用代码（必填）、联系人（可选）、风险评级（D/C/B/A/R 五档，默认 C）。旧种子行（无信用代码/联系人/风险）读取容忍并回填默认，新建/更新强制新字段。
- **审批**：变更单走自身精简生命周期，沿用既有「admin 审批、提交人自审拒绝、意见必填」纪律（不复用合同多级审批链对象——见 Implementation Decisions）。amendment 创建后 `draft`，提交 → `in_review`（editor/admin），admin 批准 → `approved`（意见必填、自审拒绝），admin apply → `applied`（执行版本继承）。
- **既有合同面**：合同列表默认排除 superseded，`?include_superseded=1` 可筛选显示；统计/到期提醒读路径同样排除 superseded（避免 v1/v2 双计）。合同表单设为从相对方库（含信用代码/风险）选择引用 `counterparty_id`。
- **前端**：变更单详情+新旧对照视图（逐字段 旧值 vs 新值）、相对方管理页（列表/增删改/去重提示）、变更单新建与审批动作、既有合同表单改造。

### 相对方字段与去重规则

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| name | string | ✔ | 去重键之一 |
| credit_code | string | ✔ | 全库唯一；提供时 409 DUPLICATE |
| contact | string | ✘ | 联系人 |
| risk_rating | `D\|C\|B\|A\|R` | ✘ 默认 C | D-R 五档 |

去重判定：`credit_code` 相同 → 一律拒绝（409，含"重名+同码"情形，被唯一性覆盖）；仅名称相同而信用代码不同 → 允许（不同主体）。删除相对方：被任一非 superseded 合同引用 → 409（避免孤儿指针）。

### 变更单生命周期状态机

| 状态 | 含义 | 可迁出 |
|---|---|---|
| `draft` | 起草中 | → in_review（提交，editor/admin） |
| `in_review` | 审核中 | → approved（admin）、→ rejected（admin） |
| `approved` | 已批准 | → applied（apply，admin） |
| `applied` | 已执行（终态·幂等） | — |
| `rejected` | 已驳回（终态） | — |

角色：创建/提交 editor+admin；批准/驳回/apply 仅 admin；提交人自审拒绝；审批意见必填。apply 仅对非 superseded 的 active 父合同可执行（404/409 否则）。

## User Stories（各带可测验收条件；验收锚定预授权 seam）

- **US1 相对方库增删改查（S2/S3）**：editor/admin 管理相对方（名称/信用代码/联系人/风险评级）。
  验收：① 合法创建返回 201 且获得格式合法唯一的 `cp_` id、`risk_rating` 默认 `C`；② 名称或信用代码缺失 → 400；③ 风险评级非 D/C/B/A/R、信用代码长度非法 → 400；④ 编辑回填并保留；⑤ viewer 创建/编辑 → 403、读 200；⑥ 删除被引用相对方 → 409。
- **US2 相对方去重（S2）**：同信用代码或重名+同码判重。
  验收：① 创建与既有实体信用代码相同 → 409 DUPLICATE 并回带既有实体；② 仅名称相同、信用代码不同 → 允许；③ 更新为已存在的信用代码 → 409；④ 旧种子行（无信用代码）不回写不崩溃、风险回填 C。
- **US3 合同表单从相对方库引用（S5）**：既有合同新建/编辑的相对方下拉来自相对方库，而非硬编码。
  验收：① 新建合同表单 options 来自真实相对方库（含名称+信用代码+风险提示）；② 提交的 `counterparty_id` 是库内存在的 id，不存在的 id → 400；③ 合同列表默认隐藏 superseded、`?include_superseded=1` 显示。
- **US4 变更单起草与审批（S1/S3）**：对已生效合同起草变更、提交、批准。
  验收：① 创建变更单要求父合同为非 superseded 的 active、`changes` 非空、键为业务主体字段 → 否则 409/400；② 初始 `draft`；③ editor/admin 提交 → `in_review`；④ viewer 创建/提交 → 403；⑤ 非 admin 批准 → 403；⑥ 提交人自审 → 403；⑦ 批准/驳回意见必填 → 缺 400。
- **US5 变更单应用：版本继承 + superseded + 指针（S1/S3）**：apply 生成继任合同并冻结父合同。
  验收：① apply 后产出继任合同 `version = 父+1`、`parent_contract_id` 回指、`status=active`、主体字段 = 父基线 + changes 覆盖、未声明字段原样继承；② 父合同 `superseded: true` 且 `superseded_by` 指继任合同；③ 金额整数分语义保持（changes 金额为整数分、非浮点）；④ 对已 `applied` 的变更单重复 apply → 409；⑤ 对 superseded 父合同新建变更 → 409。
- **US6 superseded 隐藏与前端两域接线（S4）**：列表默认隐藏已 superseded 合同，可筛选显示；变更单 UI + 相对方管理 UI 消费真实 API。
  验收：① 既有合同列表接口默认不含 superseded、含参数时含；② 统计/到期提醒不把 superseded 与继任版双计；③ 变更单详情渲染逐字段新旧对照（旧值=父当前值，新值=changes）；④ 相对方管理页列表/增删改/去重提示走真实 API；⑤ 页面挂载后经真实 API 冒烟。

## Implementation Decisions（含执行中涌现决策的推荐解）

- **superseded 用布尔字段而非新增 STATUS**：合同 `STATES` 已 7 态，与角色矩阵、迁移白名单、`color.status` 徽标、`computeStats` 强耦合；为其新增"superseded"状态会重定义既有状态机与统计语义、波及面过大。改为合同布尔 `superseded` + `superseded_by`/`superseded_at`，派生"已失效版本"；默认读路径（列表/统计/提醒）排除之。**这是对 brief「原合同转 superseded」的落地点定义**，零波及既有 7 态语义。
- **版本链**：合同增 `version`（老合同无 → 视为 1）与 `parent_contract_id`（原合同无）；apply 产出 `version = 父.version + 1`。满足 C4「v1 起始递增」。
- **变更单审批不复用合同多级链对象**：既有 `openChain/resolveStep` 绑定 `contract_id`+金额快照并驱动**合同**状态跳转（in_review→pending_sign），直接套给无签署环节的变更单需重造链路且语义错位；变更单是无签署的内部审批（单 admin 决策），故采用自身精简生命周期并**复用其纪律**（admin 审批、自审拒绝、意见必填）。——此为涌现决策，按 brief C4「同类决策按推荐解处理」执行。
- **changes 存新值、旧值 apply 时从父合同解析**：避免存储冗余分歧源；"新旧对照"在详情/apply 时由父合同当前值派生（旧）/changes（新）。满足「记录变更字段（新旧值对照）」且无脏旧值。
- **相对方信用代码唯一（去重骨干）**：统一社会信用代码全国唯一，故以之做硬唯一；"重名+同码"被其覆盖；仅重名不同码则视为不同主体允建。
- **apply 写继任合同进既有合同存储，不新建存储**：合同仍为单一事实源，继任合同与父合同同存储天然同链可查；superseded 排除只发生在读侧。
- **既有相对方旧结构容错**：`data/counterparties.json` 现仅 `id`+`name`；读取缺信用代码/联系人不回写、风险默认 `C`，不迁移炸库。
- **身份 seam（沿用）**：`X-User-Role: admin|editor|viewer` + `X-User-Id`，服务端授权；真认证为 non-goal。

## Testing Decisions（只测外部行为，`node:test` 零依赖）

- **S1 变更单域单元（T3）**：校验、状态机矩阵（合法/非法边、自审拒绝、意见必填）、apply 版本继承与 superseded/指针、幂等、金额整数分、重复 apply。金额/越权/非法跳转三类缺陷场景各 ≥1（process.md）。
- **S2 相对方域单元（T1）**：校验矩阵、信用代码唯一去重、重名再判、旧种子容错、风险默认 C、store 往返。
- **S3 API 集成（T2/T4）**：临时端口真实 server；相对方 CRUD+去重+角色拒绝、变更单 CRUD+审批+apply 端到端、apply 后合同链 409/404 语义；金额/越权/非法状态跳转各 ≥1。
- **S5 合同面（T5）**：列表默认排除 superseded/参数含、统计与提醒不双计、表单提交不存在 counterparty_id → 400。
- **S4 UI 冒烟（T6）**：静态可达、相对方管理页与变更单详情/新旧对照从真实 API 渲染、操作走真实 API。

## Out of Scope

- amendment 的 PDF 重新生成（打印视图 Run E）；相对方风险评估 AI 化（D-R 为人工/默认）；跨仓合同变更（仅单仓内）。
- 合同既有 7 态语义变更（superseded 不改 STATUS）；统计/提醒对该"失效版本"的治理仅做读侧排除，不新增终态。
- 真认证/SSO；相对方导入导出；变更单多级审批链（单 admin 直批）。
- 里程碑/收付款在变更单中的跨版对账（本迭代变更单只做主体字段继承）。