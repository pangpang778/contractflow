// shared/stats.js — 统计聚合 + 报告数据派生（S1，pure）。
// 状态分布 / 总金额 / 按状态金额 / 本月到期 / 即将到期 / 审批链超时。
// 全部纯函数、now 注入可测；不透传 http/store。金额整数分语义，全程无浮点。
import { STATES, TERMINAL } from './contracts.js';

// 管理周报视角 SLA：7 天未决即超额。经 computeOverdueChains 的 slaDays 参数可调。
export const STATS_SLA_DAYS = 7;

const DAY_MS = 86_400_000;

// now → 该日 UTC 零点（days_left 与 reminders 的日差口径对齐，保证差为整日）。
function dayStart(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// YYYY-MM-DD → 本地时区 Date（"本月到期"按本地时区判自然月）。
function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function byEndDateAsc(a, b) {
  return a.end_date < b.end_date ? -1 : a.end_date > b.end_date ? 1 : 0;
}

/**
 * 状态分布 / 总金额 / 按状态金额 / 本月到期清单。
 * @param {Array} contracts 合同（含 status、amount 整数分、end_date）
 * @param {Date|string} now 当前时间（注入，保证确定性）
 * @returns {{currency:string, total_cents:number, by_status:Record<string,number>,
 *            by_status_cents:Record<string,number>, ending_this_month:Array}}
 */
export function computeStats(contracts, now) {
  const by_status = {};
  const by_status_cents = {};
  for (const s of STATES) {
    by_status[s] = 0;
    by_status_cents[s] = 0;
  }

  let total_cents = 0;
  const ending = [];

  // 本月边界（本地时区）：首日…末日，含首末。
  const n = new Date(now);
  const firstDay = new Date(n.getFullYear(), n.getMonth(), 1);
  const lastDay = new Date(n.getFullYear(), n.getMonth() + 1, 0);

  for (const c of contracts) {
    const amount = Number.isInteger(c.amount) ? c.amount : 0;
    by_status[c.status] += 1;
    by_status_cents[c.status] += amount;
    total_cents += amount;

    if (TERMINAL.has(c.status)) continue; // archived/void/expired 排除
    if (typeof c.end_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.end_date)) continue;
    const ed = parseLocalDate(c.end_date);
    if (Number.isNaN(ed.getTime())) continue;
    if (ed >= firstDay && ed <= lastDay) ending.push(c);
  }

  ending.sort(byEndDateAsc);
  return { currency: 'CNY', total_cents, by_status, by_status_cents, ending_this_month: ending };
}

/**
 * 即将到期明细：status==='active' 且 0 ≤ days_left ≤ horizonDays 的合同，按 end_date 升序。
 * 天窗锚定既有 REMINDER_TIERS[0]=30（偏差③）；days_left = ceil((end_date−today)/86400000)。
 * @param {Array} contracts
 * @param {Date|string} now
 * @param {{horizonDays?:number}} [opts]
 * @returns {Array} 合同对象（含 days_left 字段）
 */
export function computeUpcoming(contracts, now, { horizonDays = 30 } = {}) {
  const today = dayStart(now);
  const out = [];
  for (const c of contracts) {
    if (c.status !== 'active' || typeof c.end_date !== 'string') continue;
    const end = Date.parse(c.end_date); // YYYY-MM-DD → 当日 UTC 零点；非法则 NaN
    if (Number.isNaN(end)) continue;
    const daysLeft = Math.ceil((end - today) / DAY_MS);
    if (daysLeft >= 0 && daysLeft <= horizonDays) out.push({ ...c, days_left: daysLeft });
  }
  out.sort(byEndDateAsc);
  return out;
}

/**
 * 审批链超时清单：仅 pending 链，当前待决步骤等待时长 **严格 >** slaDays 者入选。
 * 等待起点：首步 → chain.created_at；非首步 → 前一步 decided_at（偏差④）。
 * waited_days 取 ceil（7.1 天读作 8，> slaDays=7）。
 * @param {Array} chains 审批链（approvals.openChain 形状）
 * @param {Array} contracts 用于按 contract_id 解析 title（title 落在输出中）
 * @param {Date|string} now
 * @param {{slaDays?:number}} [opts]
 * @returns {Array<{chain_id:string, contract_id:string, title:string|null, submitter_id:string,
 *                   level:number, role:string, waited_days:number}>}
 */
export function computeOverdueChains(chains, contracts, now, { slaDays = STATS_SLA_DAYS } = {}) {
  const titleByContract = new Map(contracts.map((c) => [c.id, c.title]));
  const nowMs = new Date(now).getTime();
  const out = [];
  for (const ch of chains) {
    if (ch.status !== 'pending') continue; // approved/rejected 永不入选
    const cur = ch.steps.find((s) => s.outcome === null);
    if (!cur) continue;
    const idx = ch.steps.indexOf(cur);

    let startMs;
    if (idx === 0) {
      startMs = new Date(ch.created_at).getTime();
    } else {
      const prev = ch.steps[idx - 1];
      if (!prev || !prev.decided_at) continue; // 上一决步无时间 → 无法计，跳过
      startMs = new Date(prev.decided_at).getTime();
    }

    const waitedDays = (nowMs - startMs) / DAY_MS;
    if (!Number.isFinite(waitedDays) || waitedDays <= slaDays) continue; // 严格 > slaDays
    out.push({
      chain_id: ch.id,
      contract_id: ch.contract_id,
      title: titleByContract.get(ch.contract_id) ?? null,
      submitter_id: ch.submitter_id,
      level: cur.level,
      role: cur.role,
      waited_days: Math.ceil(waitedDays),
    });
  }
  return out;
}