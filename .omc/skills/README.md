# Project Skills（项目可复用能力）

本项目沉淀的可复用能力：专用工具、提示词模板、专用实践。
一个技能一个文件 `<name>.md`，frontmatter 必须含 name + description。
判断标准与 skillify 一致：5 分钟能 Google 到的不配做技能；写"本项目特有的决策纪律"，不写通用教程。

## 当前状态
空（待沉淀）。本项目头几个可孵化的候选（出现两次复用即升级为技能）：
- 合同状态机转移校验的测试模板（`node:test` 覆盖 draft→…→archived 全路径）
- 金额"分↔元"转换的纯函数与其边界用例
- 生成 tokens CSS 的脚本用法（见 design-system/tokens/README.md）
- 变更单（amendment）diff 生成规则

## 归属
- 专用领域纪律放这里；设计模式放 design-system/；业务背景放 docs/business/；术语唯一事实源是 CONTEXT.md —— 技能不要重复这份背景，只写本项目独特的"怎么做"。