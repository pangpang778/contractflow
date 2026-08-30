# contractflow — Agent & Human Shipyard

内部合同管理 Web 应用：覆盖合同全生命周期（起草 → 审核 → 签署 → 履行 → 变更 → 结算 → 归档）。
shipyard 规范入口在本文件；全文规范在 docs/standards/；术语以 CONTEXT.md 为准。

## 项目约定
- 语言: Node.js ≥24，零运行时依赖（无框架、无 bundler），ESM 模块
- 后端: node:http 起服务；前端: vanilla HTML/CSS/JS，无构建步骤
- 测试: node:test（`node --test`），无额外依赖
- 版本控制: 无 `package-lock.json`、无 `node_modules` 提交；依赖若有，锁版本并注明理由
- 命名: 文件名 kebab-case；领域词 snake_case 存字段；函数 camelCase
- 数据存储: 本地 JSON 文件为 Storage（可替换），不引入数据库运行时依赖
- 文档语言: 中文（代码标识符/提交消息保持英文）
- 命名惯例需新术语时，先补录 CONTEXT.md 再用，不临时发明

## 架构原则
- 金额运算一律用整数（单位：分）或 Decimal 语义，禁止浮点 —— 合同金额/收付款出错不可接受
- 签署/生效后的合同主体内容只读冻结；变更走"变更单(amendment)"继承原合同，不原地改
- 权限边界最多到内部角色（admin / editor / viewer），审批字段只读由服务端强校验，不信前端
- 领域逻辑集中在 server 端，前端只做展示与表单，不复制业务规则
- 相对方（counterparty）与合同（contract）解耦为独立实体，合同引用相对方，避免录入重复

## 规范索引（全文在 docs/standards/）
- 架构规范: docs/standards/architecture.md
- 数据规范: docs/standards/data.md
- 流程规范: docs/standards/process.md

## 决策记录（全文在 docs/adr/，此处只列 load-bearing 的）
- ADR-0001: adopt shipyard harness（本仓库的共享环境基座）

## 共享背景
- 术语: CONTEXT.md ｜ 业务知识: docs/business/ ｜ 决策背景: docs/adr/

## Agent 指南
- 交付走 /oh-my-claudecode:launch（spec → tickets → 执行）; issue 同步 GitHub
- 术语冲突以 CONTEXT.md 为准；新术语当场补录
- 可复用能力沉淀到 .omc/skills/；UI 模式沉淀到 design-system/
- 改金额/权限/合同状态字段时，跑 `node --test`（规则：领域逻辑改动必配测试）