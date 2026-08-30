# Mission Brief — 合同 CRUD + 状态机 (C1)

## Objective
实现合同全生命周期管理的 MVP 基座：合同 CRUD、生命周期状态机
（draft → in_review → approved → signed → active → expired/archived）、
角色权限（admin/editor/viewer）、内部工作台 UI（列表/详情/新建表单）。

## Scope boundary
- 存储：本地 JSON 文件（data/contracts.json，原子写），零运行时依赖
- API：node:http，`/api/contracts` CRUD + `/:id/status` 迁移 + 角色校验
- UI：vanilla HTML/CSS/JS（tokens.css 令牌），列表+详情+表单
- 角色：admin 全权 / editor 增改 / viewer 只读——服务端强校验，不信前端
- 文档语言：中文（跟 harness）

## Non-goals
审批工作流（下一功能）、到期提醒、PDF 生成、电子签、看板

## Pre-approved seams（C2 预授权）
- S1 存储层单元（状态机矩阵/CRUD/并发原子写/ID 分配 C-NNNN）
- S2 HTTP API 集成（临时端口/校验矩阵/角色拒绝）
- S3 前端冒烟（静态可达 + 挂载点）

## Ticket 期望
3 张串行垂直切片：T1 状态机+存储、T2 API+角色校验、T3 工作台 UI。共享存储面 → 串行。
