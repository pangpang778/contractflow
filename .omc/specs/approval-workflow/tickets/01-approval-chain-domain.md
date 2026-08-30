# T1 审批链域模型 + 存储接线（seam S1）· 候选 (待 C3 批准)

`blockedBy: []` — 领域纯函数与存储复用，无前置。
目标：把"金额→审批链、链/步骤状态机、留痕形状"做成单一事实源的纯规约，并把 approvals 与 outbox 两块存储接到服务端接线。
状态：候选 —— 批准后标 `ready-for-agent`。

## 交付切片（跨面但单点演示）
- **shared/approvals.js（纯函数，不透传 http/store）**：
  - 常量 `TWO_LEVEL_THRESHOLD_CENTS = 10_000_000`、金额分级 → 步骤角色集：
    - `amount < 10_000_000` → `[{level:1, role:'admin'}]`
    - `amount >= 10_000_000` → `[{level:1, role:'admin'}, {level:2, role:'legal'}]`
  - `newId('ap')` 前缀生成链 id（复用 shared/ids.js）；链结构：`{id, contract_id, amount(快照分), submitter_id, status(pending|approved|rejected), steps:[{level, role, outcome:null|'approved'|'rejected', approver_id, comment, decided_at}], created_at}`。
  - 纯变换：`openChain`（submit 建档）、`currentStep`（当前待决步骤）、`resolveStep`（通过/驳回标记留痕）、`isChainComplete`。
- **存储接线**：`server/index.js` 复用 `createFileStore` 分别建 `data/approvals.json`（存链）与 `data/outbox.json`（存事件），随 store 一并传入 `createApp`。复用既有锁 + 原子写，不新增存储机械。
- small `getChainByContract(store, contract_id)` 查询助手（list 扫描）。

## 验收条件（机械可判）
1. S1 金额分级边界全过：`< 阈值` 1 级、`== 阈值` 2 级、`> 阈值` 2 级；步骤角色集正确。
2. 链/步骤状态机：openChain 初始 `pending` 且所有步 `outcome:null`；resolveStep 只允许当前待决步骤，通过后推进到下一级。
3. 留痕形状：某步被决定后 `approver_id / role / comment / decided_at / outcome` 齐全。
4. 存储复用接线：approvals store `create/get` 原子落盘可读回；outbox store append 多条事件后 list 全量可读。
5. 无任何 http 引入 shared 层；金额以整数分快照，禁止浮点。

## 演示/验证（S1）
`node --test`：链生成器边界、链状态规约、留痕形状、存储 read-round-trip 通过；`server/index.js` 能起并挂载三个 store。