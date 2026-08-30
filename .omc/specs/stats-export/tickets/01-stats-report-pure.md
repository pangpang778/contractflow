# T1 统计聚合 + 周报渲染纯函数（seam S1+S2）· 候选 (待 C3 批准)

`blockedBy: []` — 两个领域纯模块，无前置、互相独立（stats 产数据、report 只消费数据对象），合并为一张切片（沿用 expiry T1=S1+S2 先例）。
目标：把"合同状态分布 / 金额汇总 / 本月到期 / 即将到期 / 审批链超时"的派生与"中文 Markdown 周报渲染"做成单一事实源的纯规约。
状态：ready-for-agent（C2+C3 已批后生效）。

## 交付切片（跨面但单点演示）
- **shared/stats.js（S1，纯函数，不透传 http/store）**：
  - `computeStats(contracts, now)` → `{ currency:'CNY', total_cents, by_status, by_status_cents, ending_this_month }`：
    - `by_status`：为全部 `STATES`（draft/in_review/pending_sign/active/archived/void/expired）各建 count=0 起点，逐合同累计（空库不崩）。
    - `total_cents` 与 `by_status_cents`：整数分求和，禁止浮点；`total_cents === Σ by_status_cents`。
    - `ending_this_month`：`end_date` 落当前自然月（首日…末日，本地时区）且 status ∉ {archived,void,expired} 的合同，按 `end_date` 升序（偏离②）。
  - `computeUpcoming(contracts, now, { horizonDays = 30 } = {})` → 即将到期明细：status==='active' 且 `0 ≤ days_left ≤ horizonDays` 的合同，按 `end_date` 升序（含当天到期 days_left=0；锚定 `REMINDER_TIERS[0]=30`，偏离③）。`days_left = Math.ceil((end_date − today)/86400000)`。
  - `computeOverdueChains(chains, now, { slaDays = STATS_SLA_DAYS } = {})` → 超时链清单：pending 链当前待决步骤等待时长 `> slaDays` 者，形状 `{chain_id, contract_id, title, submitter_id, level, role, waited_days}`。等待起点：首步 → `chain.created_at`；非首步 → 前一步 `decided_at`（二级链第二步自首步通过起计，偏离④）。`STATS_SLA_DAYS = 7` 常量。approved/rejected 链永不入选。
- **shared/report.js（S2，纯函数）**：
  - `formatYuan(cents)` → 千分位元字符串（`123456` → `1,234.56`）。
  - `renderReport(payload)` → 中文 Markdown 字符串。`payload = { generated_at, stats, upcoming, overdue }`：
    - 标题 + 生成日期；
    - **统计表**：Markdown 表格，行 = 状态 → 合同数 → 金额（元，`formatYuan`），含合计行；
    - **即将到期明细**：按 `end_date` 升序，列含标题/相对方/金额/到期日/剩余天数；
    - **超时清单**：pending 超 SLA 链，列含链 id/合同/提交人/当前步骤(level+role)/等待天数；
    - 单元格 `escCell` 转义 `|` → `\|`、换行/`\n` → 空格，不破表；空数据不崩。
- 测试：`test/stats.test.js`（S1）、`test/report.test.js`（S2），`node --test`。

## 验收条件（机械可判）
1. S1 空库：by_status 全 0、total_cents=0、by_status_cents 全 0、ending_this_month=[]，不崩。
2. S1 分布/金额：多状态 count 正确；total_cents 整数和；`total_cents === Σ by_status_cents`；无浮点。
3. S1 本月到期边界：end_date 在首日/末日计入、上月/下月排除、archived/void/expired 排除、升序。
4. S1 即将到期边界：days_left 0/30 入、31 出；仅 active；升序。
5. S1 超时边界：wait==slaDays 不入、slaDays+1 入；首步从 created_at、二级链第二步从首步 decided_at 起计；approved/rejected 不入。确定性（now 注入）。
6. S2 渲染：统计表含合计；千分位（123456→`1,234.56`）；标题含 `|`/换行不破表；即将到期升序；超时行六字段；空数据返回合法字符串。
7. 两模块零透传：不 import http/store；金额以整数分经 S1 产出、S2 才转元（不把浮点入存储）。
8. 演示切片自证：`node --test test/stats.test.js test/report.test.js` 全绿。

## 演示/验证（S1+S2）
`node --test` 跑上述两个单元文件；两模块纯、now 注入可控、断言机械可判。