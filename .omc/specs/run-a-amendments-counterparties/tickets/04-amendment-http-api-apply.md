# T4 变更单 HTTP API + apply 接线（seam S3）· ready-for-agent（C3 预授权）

`blockedBy: [03-amendment-domain]` — 领域就绪后暴露 CRUD/审批/apply。
目标：把变更单起草/审批/应用变为可测外部行为，apply 端到端落合同存储并写版本链。

## 交付切片（跨面但单点演示）
- **服务端路由（既有中央 server 新增 addon 块，纯增量）**：`POST/GET /api/amendments`、`GET /api/amendments/:id`、`POST /api/amendments/:id/submit|approve|reject|apply`；委托 T3 领域纯函数，错误信封统一 `{ok,data,error}`。
- **审批动作入 API**：submit（draft→in_review，editor/admin）、approve/reject（admin，意见必填），提交人自审拒绝（服务端由 `X-User-Id` 判定，不信前端）。
- **apply 接线（写合同存储 + 版本链）**：`POST /api/amendments/:id/apply`（admin）调用 T3 apply：以 stores 内父合同为基线写继任合同进**既有合同存储**、在**同一存储**内把父合同更新为 superseded 形态；前置校验（父为 active 且非 superseded、变更单 approved）→ 否则 409；成功落变更单 `resulting_contract_id`。
- **只读细节**：`GET /api/amendments/:id` 返回变更单并对每个 changed 字段给「旧值=父当前值、新值=changes」对照载荷（供前端新旧对照视图，S4）。
- **接线（entry-point）**：创建 AmendmentStore（`data/amendments.json`）；`store`（合同）、`counterpartyStore`、`amendmentStore` 注入路由。

## 验收条件（机械可判）
1. 角色矩阵：viewer 读 200、创建/提交/审批/apply 403；editor 创建/提交 200、approve/reject/apply 403；admin 全链 200；身份缺失 → 401。
2. 创建校验：父合同非 active 或已 superseded → 409；changes 非法（空/含非冻结键/金额浮点）→ 400；合法 → 201 且 `status=draft`。
3. 审批：submit → in_review；approve（意见必填）→ approved；自审 → 403；reject → rejected；rejected 后再提交 → 409。
4. apply 端到端：approved 且父为当前版本 → 200 返回继任合同；父合同 `superseded:true` 且 `superseded_by` 指继任；继任 `version=父+1`、`status=active`；重复 apply → 409；变更单非 approved apply → 409。
5. 对照载荷：每个 changed 键含 `field, from(father current), to(changes)`。
6. 错误信封统一、不抛栈；金额/越权/非法状态跳转三类缺陷场景各 ≥1。

## 演示/验证（S3）
`node --test`：临时端口启动真实 server（合同 + 变更单 + 相对方存储全接线），变更单 CRUD、审批链、apply 版本继承端到端、幂等 409、对照载荷通过。