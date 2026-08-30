# scripts（脚本）

零运行时依赖、Node ≥24 的可执行脚本。每个脚本顶部 docstring 说明用途、入参、退出码。

## 当前状态
空。规划中的脚本（先例见 design-system/tokens/README.md 的 gen-css）：
- `gen-css.mjs` — 读 `design-system/tokens/*.json` 生成 `:root{}` CSS 变量文件（令牌单一事实源落地前端）。
- `serve.mjs` — 起 node:http 静态服务 + JSON API（内部工作台入口）。
- `seed.mjs` — 写入演示合同/相对方/里程碑/收付款样例数据（仅供本地体验）。

## 约定
- `.mjs` 扩展名，`node scripts/xxx.mjs` 直接运行；无编译、无 bundler。
- 副作用脚本（建数据、起服务）要打印人类可读的一行结果并正确退出码。
- 不想进 git history 的产物放 `.gitignore`（如生成的 `dist/`、本地 `data/`），不靠删除文件。