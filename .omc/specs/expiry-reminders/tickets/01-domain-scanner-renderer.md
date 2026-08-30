# T1 到期提醒扫描器 + 中文模板渲染（seam S1+S2）· 候选 (待 C3 批准)

`blockedBy: []` — 两个领域纯函数，无前置、互相独立，合并为一张切片。
目标：把"哪些 active 合同该在到期前 30/7/1 天建档提醒"与"事件类型 → 中文邮件变量替换"做成单一事实源的纯规约。
状态：ready-for-agent（C2+C3 已批）。

## 交付切片（跨面但单点演示）
- **shared/reminders.js（S1，纯函数，不透传 http/store）**：
  - 常量 `REMINDER_TIERS = [30, 7, 1]`。
  - `computeDueReminders(contracts, now, alreadySent)` → 应提醒清单 `[{contract_id, tier, due_date, days_left, sent_key}]`：
    - 只看 `status === 'active'` 的合同；非 active 全跳过。
    - `days_left = Math.ceil((end_date - today) / 86400000)`（`end_date` 为 `YYYY-MM-DD`；now 注入）。
    - 缺失/非法 `end_date` → 跳过不崩（无到期日）；`end_date < today`（已过期）→ 跳过。
    - 对每档 T∈[30,7,1]：`days_left <= T` 且 `sent_key = contract_id + ':' + T` 不在 `alreadySent` → 产一条提醒；天数边界当天到期（days_left=0）仍触发 1 档。
- **shared/mail.js（S2，纯函数）**：
  - `TEMPLATES`：`approval.requested / approval.approved / approval.rejected / reminder.due` 各一条中文 `{subject, body}` 模板，含 `{{var}}` 占位（如 `{{title}}`、`{{amount_yuan}}`、`{{days_left}}`）。
  - `renderTemplate(type, vars)` → `{subject, body}`：双花括号占位替换为 vars 值；**缺键 → 补 `—` 不抛**；**替换值 HTML 转义**（`& < > " '`）不注入原始 HTML。
- 测试：`test/reminders.test.js`（S1）、`test/mail.test.js`（S2），`node --test`。

## 验收条件（机械可判）
1. S1 档位边界全过：0 天（当天到期→1 档）、≤1（1 档）、≤7（7 档、不重发 30）、≤30（30 档）；已过期/无 end_date 跳过；非 active 过滤。
2. S1 去重：`alreadySent` 含 `contract_id:30` → 该合同 30 档不产、7/1 档仍产；`sent_key == \`${contract_id}:${tier}\`` 唯一。
3. S2 每类型有中文模板；`{{title}}` 正确替换；缺变量 → `—` 不抛；`<`/`&`/`"` 值渲染后已转义；输出形状 `{subject, body}`。
4. 两模块零透传：不 import http/store；金额以整数分传递给调用方，本层不改算术。
5. 演示切片自身可独立验证：`node --test test/reminders.test.js test/mail.test.js` 全绿。

## 演示/验证（S1+S2）
`node --test` 跑上述两个单元文件；扫描器与渲染器均纯、时间注入可控、断言机械可判。