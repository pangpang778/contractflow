# 流程规范（Process Standards）

规定贡献者（人与 agent）如何交付、如何沉淀、何时测试。空节合法——沉淀渐进。

## 交付流程
- 功能走 /oh-my-claudecode:launch（spec → tickets → 执行）；issue 同步 GitHub tracker。
- 改动落地到 shipyard 的某个面（docs/standards/、.omc/skills/、design-system/、CONTEXT.md、ADR），说不清落哪个面的改动是坏味道。
- 为什么: 结构沉淀、可追溯，不让知识回流入人脑。

## 领域逻辑必配测试
- 改动涉及金额、权限、合同状态机字段时，必须带 `node --test`/`node:test` 用例。
- 金额、越权、非法状态跳转三类场景各至少一条。
- 为什么: 合同系统正确性不可靠口头保证；node:test 零依赖，门槛低到应该人人做。

## 术语纪律
- 新术语先补录 CONTEXT.md 再在代码/文档引用；术语冲突以 CONTEXT.md 为准。
- 为什么: 一个术语一个含义，避免"合同"指代漂移。

## 变更与失效
- 规范改走"改文件 + 留 ADR 或注释"两选一，不许只靠微信群/口头传。
- 过时规范优先删除而非注释掉（避免死文档陷阱）。
- 为什么: 规范必须与现状一致，漂白即失去"准绳"效力。

## 代码审查与沉淀
- 交付后 review 一次；重复出现的纠正（≥2 次同类问题）沉淀成 docs/standards/ 或 CLAUDE.md 原则。
- 为什么: 一次纠正变永久规范，而非每次犯同样的错。

## 反向清单（不做什么）
- 不为预想规模加数据库/加缓存/加框架（YAGNI）。
- 不信任前端回传的业务字段做权限/金额决策。
- 不在 git 历史里留 node_modules 或 package-lock 噪声（见 .gitattributes / 项目约定）。