# ADR-0001: adopt shipyard harness（共享环境基座）

- 状态: 已采纳（2026-08-30）
- 决策人: shipyard 初始化（drydock）

## 背景（为什么）
仓库从零起步，将被人与 agent 共同建设。若没有一个共享的规范面（术语、架构、数据、流程、设计语言），每个贡献者会各自发明一套约定，随规模扩大化为无法弥合的漂移。目标是"新成员靠读文件继承上下文，而非靠问人"。

## 决策
采纳 shipyard 四支柱共享环境（Context/Rules/Tools/Standards）五面落地：
- 面 1 `CLAUDE.md`（约定+原则+索引，薄入口）
- 面 2 规范 `docs/standards/`（architecture / data / process）
- 面 3 决策与业务 `docs/adr/` + `docs/business/`
- 面 4 设计语言 `design-system/`（UI 仓库全量，非桩）
- 面 5 工具箱 `.omc/skills/` + `.mcp.json` + `scripts/`

## 影响
- docs/adr/ 以后每条决策一个文件，ADR 编号递增。
- 术语冲突以 CONTEXT.md 为准。
- 新规范沉淀到 docs/standards/，不塞进人脑与聊天记录。

## 替代方案
- 不建基座、随建随写 —— 否决：正是要避免的漂移来源。
- 单一巨型 CLAUDE.md —— 否决：脆弱、并发编辑冲突、职责不分层。