// shared/report.js — 中文管理周报渲染（S2，pure）。
// 消费 computeStats / computeUpcoming / computeOverdueChains 的输出数据对象 → 中文 Markdown 字符串。
// 分→元展示层 formatYuan + 千分位；Markdown 单元格 escCell 转义；空数据不崩。不透传 http/store。
import { STATES } from './contracts.js';

const HEADERS = {
  stats: ['状态', '合同数', '金额（元）'],
  upcoming: ['标题', '相对方', '金额（元）', '到期日', '剩余天数'],
  overdue: ['审批链', '合同', '提交人', '当前步骤', '等待天数'],
};

/** 单元格转义：`|` → `\|`；真实换行与字面 `\n` → 空格，避免破表。 */
export function escCell(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/\\n/g, ' ');
}

/** 整数分 → 千分位元字符串（展示层，不做算术入存储）。/100 转元，整数部千分位，恒 2 位小数。 */
export function formatYuan(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const intPart = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${frac}`;
}

function byEndDateAsc(a, b) {
  return a.end_date < b.end_date ? -1 : a.end_date > b.end_date ? 1 : 0;
}

// 生成日期：generated_at 的 UTC 年月日 → 中文日期串（确定性，不随手时区漂移）。
function chineseDate(generatedAt) {
  const d = new Date(generatedAt);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/**
 * @param {{generated_at:Date|string, stats?:object, upcoming?:Array, overdue?:Array}} payload
 * @returns {string} 中文 Markdown 周报
 */
export function renderReport(payload) {
  const { generated_at, stats = {}, upcoming = [], overdue = [] } = payload;
  const lines = [];

  lines.push('# 合同管理周报', '', `生成日期：${chineseDate(generated_at)}`, '');

  // ── 状态统计表 ──
  lines.push('## 状态统计', '');
  lines.push(`| ${HEADERS.stats.join(' | ')} |`);
  lines.push(`| ${HEADERS.stats.map(() => '---').join(' | ')} |`);
  const byStatus = stats.by_status ?? {};
  const byStatusCents = stats.by_status_cents ?? {};
  let totalCount = 0;
  for (const s of STATES) {
    const count = byStatus[s] ?? 0;
    const cents = byStatusCents[s] ?? 0;
    totalCount += count;
    lines.push(`| ${escCell(s)} | ${count} | ${formatYuan(cents)} |`);
  }
  lines.push(`| 合计 | ${totalCount} | ${formatYuan(stats.total_cents ?? 0)} |`);

  // ── 即将到期明细（按 end_date 升序）──
  lines.push('', '## 即将到期明细', '');
  const up = [...upcoming].sort(byEndDateAsc);
  lines.push(`| ${HEADERS.upcoming.join(' | ')} |`);
  lines.push(`| ${HEADERS.upcoming.map(() => '---').join(' | ')} |`);
  for (const u of up) {
    lines.push(
      `| ${escCell(u.title)} | ${escCell(u.counterparty_id)} | ${formatYuan(u.amount)} | ${escCell(u.end_date)} | ${u.days_left ?? ''} |`,
    );
  }

  // ── 超时清单 ──
  lines.push('', '## 超时清单', '');
  if (overdue.length === 0) {
    lines.push('无超时审批链。');
  } else {
    lines.push(`| ${HEADERS.overdue.join(' | ')} |`);
    lines.push(`| ${HEADERS.overdue.map(() => '---').join(' | ')} |`);
    for (const o of overdue) {
      lines.push(
        `| ${escCell(o.chain_id)} | ${escCell(o.title)} | ${escCell(o.submitter_id)} | L${o.level} ${escCell(o.role)} | ${o.waited_days} |`,
      );
    }
  }

  return lines.join('\n') + '\n';
}