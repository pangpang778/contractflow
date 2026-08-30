// shared/reminders.js — 到期提醒扫描器：纯函数，不透传 http/store。
// 给定 active 合同集 + 当前时间 + 已发送 sent-key 集合 → 应提醒清单。
// 档位 30/7/1：按"到期前 N 天窗"触发（(7,30]→30、(1,7]→7、[0,1]→1），同档靠 sent-key 去重。

export const REMINDER_TIERS = [30, 7, 1];
// 每档的下界（开区间）：30 档在 (7,30]、7 档在 (1,7]、1 档在 (-1,1]（含当天）。
const TIER_LOWER = { 30: 7, 7: 1, 1: -1 };
const DAY_MS = 86_400_000;

// now → 该日 UTC 零点（与 YYYY-MM-DD 解析对齐，保证日差为整）。
function dayStart(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * @param {Array<{id:string,status:string,end_date?:string}>} contracts
 * @param {Date|string} now
 * @param {Set<string>|ReadonlySet<string>} [alreadySent] sent-key 集合（已发送队列的 sent_key 汇总）
 * @returns {Array<{contract_id:string,tier:number,due_date:string,days_left:number,sent_key:string}>}
 */
export function computeDueReminders(contracts, now, alreadySent = new Set()) {
  const today = dayStart(now);
  const out = [];
  for (const c of contracts) {
    if (c.status !== 'active' || typeof c.end_date !== 'string') continue;
    const end = Date.parse(c.end_date); // YYYY-MM-DD → 该日 UTC 零点；非法返回 NaN
    if (Number.isNaN(end)) continue;
    const daysLeft = (end - today) / DAY_MS;
    if (!Number.isInteger(daysLeft) || daysLeft < 0) continue; // 已过期/跨日非整 → 跳过
    for (const tier of REMINDER_TIERS) {
      if (daysLeft <= tier && daysLeft > TIER_LOWER[tier]) {
        const sentKey = `${c.id}:${tier}`;
        if (alreadySent.has(sentKey)) continue;
        out.push({ contract_id: c.id, tier, due_date: c.end_date, days_left: daysLeft, sent_key: sentKey });
      }
    }
  }
  return out;
}