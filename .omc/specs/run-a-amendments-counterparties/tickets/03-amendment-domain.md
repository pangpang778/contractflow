# T3 变更单域：校验 + 状态机 + apply（seam S1）· ready-for-agent（C3 预授权）

`blockedBy: []` — 起点，无阻塞。与 T1（相对方域）文件面不相交，可并行。
目标：把变更单的合法性、审批生命周期、版本继承与 superseded 指针做成可判对错的纯函数，杜绝只在 API 层临时拼。

## 交付切片（跨面但单点演示）
- **领域纯函数（新模块，契约新增）**：
  - 变更单校验：`reason` 必填、`parent_contract_id` 必填、`changes` 非空且键 ⊆ 合同业务主体字段（金额/名称/期限/相对方等冻结字段）、`changes` 内金额为整数分（非法浮点 → 拒）。
  - 状态机矩阵：`draft → in_review`（提交，editor/admin）、`in_review → approved`（admin）、`in_review → rejected`（admin）、`approved → applied`（apply，admin）；终态 `applied`/`rejected` 无出边。自审拒绝（提交人不得批准自己的变更单）；审批意见必填。
  - apply 纯函数：以父合同主体字段为基线，仅覆盖 `changes` 声明的键，生成**继任合同** `status=active`、`version = 父.version + 1`（父无 version → 视为 1）、`parent_contract_id` 回指父；父合同标 `superseded:true` + `superseded_by` 指继任 + `superseded_at`；返回 `{ superseded, next }`，均新对象不 mutate 入参。
  - 幂等/前置：apply 仅对非 superseded 的 active 父合同、且变更单处于 `approved` 可执行；重复 apply 拒绝；apply 落 `resulting_contract_id`。
- **ID**：变更单 `am_<epoch>-<rand>`（新前缀分域，ids 工厂新增）。

## 验收条件（机械可判）
1. 校验矩阵：缺 reason/缺父合同/changes 空/changes 含非冻结字段/changes 金额浮点 → 拒；合法通过。
2. 状态机矩阵：合法边各推进正确状态；非法跳转（draft→approved、approved→rejected、终态出边）→ 拒；非 admin 批准 → 拒；自审 → 拒；意见缺失 → 拒。
3. apply 版本继承：继任 `version = 父+1`、`parent_contract_id` 回指、`status=active`、主体字段 = 父基线 + changes 覆盖、未声明字段原样继承。
4. superseded 指针：父 `superseded:true` 且 `superseded_by` 指继任 id；`superseded_at` 落 ISO 时间。
5. 幂等/前置：已 `applied` 重复 apply → 拒；对 superseded 父 → 拒；非 approved 态 apply → 拒。
6. 不可变：apply/迁移返回新对象，父合同对象不被 mutate。
7. 金额/越权/非法跳转三类缺陷场景各 ≥1（process.md 强制）。

## 演示/验证（S1）
运行 `node --test`：变更单校验、状态机矩阵（含自审/意见/角色）、apply 版本继承与 superseded 指针、幂等、金额整数分各一组用例通过。