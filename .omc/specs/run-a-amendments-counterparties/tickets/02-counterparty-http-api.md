# T2 相对方 HTTP API + 角色矩阵（seam S3）· ready-for-agent（C3 预授权）

`blockedBy: [01-counterparty-store-dedup]` — 领域/存储就绪后暴露。
目标：把相对方去重/校验/角色拒绝变为可测的外部行为；以真实存储取代既有静态种子只读接口。

## 交付切片（跨面但单点演示）
- **服务端路由（既有中央 server 新增 addon 块，纯增量）**：`POST/GET /api/counterparties`、`GET/PATCH/DELETE /api/counterparties/:id`；委托 T1 领域纯函数（不在路由层重写规则），错误信封统一 `{ok,data,error}`。
- **接线（entry-point 依赖注入）**：服务启动创建 CounterpartyStore（`data/counterparties.json`），取代现由 index 注入的静态种子数组；既有只读 `GET /api/counterparties` 改为读存储的完整形态（含信用代码/联系人/风险）；旧静态种子数据被容错读取为合法行（T1）。
- **角色矩阵**：读（GET 列表/详情）viewer 可读；创建/编辑 editor+admin；删除仅 admin；身份缺失/非法 → 401/403，绝不落入业务分支。
- **去重入 API**：创建/更新撞同信用代码 → 409 DUPLICATE 并在 error 携带既有实体 id；删除被任一非 superseded 合同引用的相对方 → 409（防孤儿指针，服务端查合同存储判定）。
- **对照视图数据**：返回字段含 `id,name,credit_code,contact,risk_rating`，`counterparty_id` 引用校验在合同接口侧（T5）消费。

## 验收条件（机械可判）
1. 角色矩阵每一行至少一条用例：viewer 读 200、创建/编辑/删除 403；editor 创建/编辑 200、删除 403；admin 删除 200；身份缺失 → 401/403。
2. 创建校验/去重：合法 201 且 `risk_rating` 默认 `C`；缺名称/信用代码 → 400；撞码 → 409 并回带既有 id；仅重名不同码 → 201。
3. 编辑：改字段成功并保留；改成已存在信用代码 → 409。
4. 删除：未引用 → 204；被非 superseded 合同引用 → 409；viewer/editor 删除 → 403。
5. 错误信封统一、不抛栈；越权/去重/非法三缺陷场景各 ≥1（process.md）。
6. wiring 冒烟：`GET /api/counterparties` 返回存储真实行（含老种子容错列）。

## 演示/验证（S3）
`node --test`：临时端口启动真实 server，相对方 CRUD、角色拒绝矩阵、去重 409、删除引用 409、错误信封通过。