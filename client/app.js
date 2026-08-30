// client/app.js — 工作台逻辑。只做展示与表单，不复制业务规则：
// 状态迁移合法性/角色权限由服务端判定（服务端强校验，不信前端）。

const STATUSES = ['draft', 'in_review', 'pending_sign', 'active', 'archived', 'void', 'expired'];
const $ = (id) => document.getElementById(id);

let role = 'editor';
let userId = 'u_1';
let counterparties = [];
let selected = null;

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'X-User-Role': role, 'X-User-Id': userId } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  let json = null;
  try { json = await r.json(); } catch { /* 204 无 body */ }
  if (!r.ok) throw new Error((json && json.error && json.error.message) || `${r.status}`);
  return json.data;
}

const money = (cents) => (cents / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const badge = (s) => `<span class="status status-${s}">${s}</span>`;

function flash(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

async function refreshList() {
  const list = await api('/api/contracts');
  const cps = new Map(counterparties.map((c) => [c.id, c.name]));
  $('contract-list').innerHTML = list.length
    ? list.map((c) => `
      <tr data-id="${c.id}">
        <td>${esc(c.title)}</td>
        <td>${esc(cps.get(c.counterparty_id) || c.counterparty_id)}</td>
        <td class="money">${money(c.amount)}</td>
        <td>${badge(c.status)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">暂无合同</td></tr>';
  document.querySelectorAll('#contract-list tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => loadDetail(tr.dataset.id).catch((e) => flash(e.message)));
  });
}

async function loadDetail(id) {
  const c = await api(`/api/contracts/${id}`);
  selected = c;
  $('detail-panel').hidden = false;
  const cps = new Map(counterparties.map((x) => [x.id, x.name]));
  $('detail').innerHTML = `
    <dt>标题</dt><dd>${esc(c.title)}</dd>
    <dt>相对方</dt><dd>${esc(cps.get(c.counterparty_id) || c.counterparty_id)}</dd>
    <dt>金额（元）</dt><dd class="money">${money(c.amount)}</dd>
    <dt>期限</dt><dd>${esc(c.start_date)} ~ ${esc(c.end_date)}</dd>
    <dt>状态</dt><dd>${badge(c.status)}</dd>
    <dt>备注</dt><dd>${esc(c.description || '—')}</dd>`;
  $('status-to').innerHTML = STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('');
  $('status-to').value = '';
  $('desc-form').description.value = c.description || '';
  await loadApproval();
}

// 审批面板：从服务端读链 + 当前待决步骤渲染；仅据此显隐动作，服务端仍强校验（前端不复算规则）。
async function loadApproval() {
  const ap = await api(`/api/contracts/${selected.id}/approval`).catch(() => ({ chain: null, current_step: null }));
  $('approval-panel').hidden = false;
  $('submit-approval').hidden = selected.status !== 'draft';
  const chain = ap.chain;
  const box = $('approval-chain');
  if (!chain) {
    box.innerHTML = '<p class="muted">无审批记录</p>';
  } else {
    box.innerHTML = `<p>审批链 #${esc(chain.id)} · ${esc(chain.status)} · 金额 ¥${money(chain.amount)}</p><ol>`
      + chain.steps.map((s) => `<li>${s.level} 级 · ${esc(s.role)} · ${s.outcome == null ? '待决' : esc(s.outcome)}${s.approver_id ? `（${esc(s.approver_id)}@${esc(s.decided_at || '')}）` : ''}${s.comment ? ` — ${esc(s.comment)}` : ''}</li>`).join('')
      + '</ol>';
  }
  const step = ap.current_step;
  const action = $('approval-action');
  const canAct = !!step && role === step.role && !!chain && chain.submitter_id !== userId;
  action.hidden = !canAct;
}

function applyIdentity() {
  refreshList().catch((e) => flash(e.message));
  if (selected) loadDetail(selected.id).catch((e) => flash(e.message));
}

async function loadCounterparties() {
  counterparties = await api('/api/counterparties');
  $('cp-select').innerHTML = counterparties.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

async function init() {
  $('role').addEventListener('change', (e) => { role = e.target.value; applyIdentity(); });
  $('userid').addEventListener('change', (e) => { userId = e.target.value.trim() || userId; applyIdentity(); });
  $('refresh').addEventListener('click', () => refreshList().catch((e) => flash(e.message)));
  $('close-detail').addEventListener('click', () => { $('detail-panel').hidden = true; selected = null; });

  $('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/contracts', {
        method: 'POST',
        body: {
          title: f.get('title'),
          counterparty_id: f.get('counterparty_id'),
          amount: Math.round(Number(f.get('amount_yuan') || 0) * 100),
          start_date: f.get('start_date'),
          end_date: f.get('end_date'),
          description: f.get('description') || undefined,
        },
      });
      e.target.reset();
      refreshList();
    } catch (err) { flash(err.message); }
  });

  $('status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected || !$('status-to').value) return;
    try {
      await api(`/api/contracts/${selected.id}/status`, { method: 'POST', body: { to: $('status-to').value } });
      loadDetail(selected.id);
      refreshList();
    } catch (err) { flash(err.message); }
  });

  $('desc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.target);
    try {
      await api(`/api/contracts/${selected.id}`, { method: 'PATCH', body: { description: f.get('description') || undefined } });
      loadDetail(selected.id);
      refreshList();
    } catch (err) { flash(err.message); }
  });

  $('submit-approval').addEventListener('click', async () => {
    if (!selected) return;
    try {
      await api(`/api/contracts/${selected.id}/submit`, { method: 'POST' });
      loadDetail(selected.id);
      refreshList();
    } catch (err) { flash(err.message); }
  });

  $('approval-action').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected) return;
    const action = e.submitter && e.submitter.name === 'reject' ? 'reject' : 'approve';
    const comment = new FormData(e.target).get('comment');
    try {
      await api(`/api/contracts/${selected.id}/${action}`, { method: 'POST', body: { comment } });
      loadDetail(selected.id);
      refreshList();
    } catch (err) { flash(err.message); }
  });

  await loadCounterparties();
  await refreshList();
}

init().catch((e) => flash(e.message));