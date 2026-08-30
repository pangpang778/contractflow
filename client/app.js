// client/app.js — 工作台逻辑。只做展示与表单，不复制业务规则：
// 状态迁移合法性/角色权限由服务端判定（服务端强校验，不信前端）。

const STATUSES = ['draft', 'in_review', 'pending_sign', 'active', 'archived', 'void', 'expired'];
const $ = (id) => document.getElementById(id);

let role = 'editor';
let counterparties = [];
let selected = null;

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'X-User-Role': role } };
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
}

async function loadCounterparties() {
  counterparties = await api('/api/counterparties');
  $('cp-select').innerHTML = counterparties.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

async function init() {
  $('role').addEventListener('change', (e) => { role = e.target.value; refreshList().catch((er) => flash(er.message)); });
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

  await loadCounterparties();
  await refreshList();
}

init().catch((e) => flash(e.message));