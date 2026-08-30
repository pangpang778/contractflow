// client/app.js — 工作台逻辑。只做展示与表单，不复制业务规则：
// 状态迁移合法性/角色权限由服务端判定（服务端强校验，不信前端）。

const STATUSES = ['draft', 'in_review', 'pending_sign', 'active', 'archived', 'void', 'expired'];
const SESSION_KEY = 'cf-session'; // localStorage: {token, role, id, expires_at}
const $ = (id) => document.getElementById(id);

let role = '';
let userId = '';
let token = '';
let counterparties = [];
let amendments = []; // 变更单列表（Run B 修复：先前缺失声明 → refreshAmendments 每次 ReferenceError）
let selected = null;
let cpEditingId = null; // 相对方编辑态（null=新建）
let amSelectedId = null; // 当前打开的变更单

const readSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; } };
const saveSession = (s) => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
const clearSession = () => localStorage.removeItem(SESSION_KEY);

function showWorkbench() {
  const s = readSession();
  $('login-view').hidden = true;
  $('app').hidden = false;
  $('session-box').hidden = false;
  $('session-role').textContent = `${s && s.role ? s.role : ''} · ${s && s.id ? s.id : ''}`;
  document.body.dataset.role = role; // CSS 按角色隐隐藏（只读），服务端仍 403 兜底
}
function showLogin() {
  $('app').hidden = true;
  $('session-box').hidden = true;
  $('login-view').hidden = false;
  delete document.body.dataset.role;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401) { clearSession(); token = ''; role = ''; userId = ''; showLogin(); throw new Error('登录已失效，请重新登录'); }
  let json = null;
  try { json = await r.json(); } catch { /* 204 无 body */ }
  if (!r.ok) throw new Error((json && json.error && json.error.message) || `${r.status}`);
  return json ? json.data : null; // 204 无 body → null
}

async function doLogin(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const loginErr = $('login-error');
  loginErr.hidden = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.get('username'), password: f.get('password') }),
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error((json && json.error && json.error.message) || `登录失败（${r.status}）`);
    const d = json.data;
    saveSession({ token: d.token, role: d.role, id: d.id, expires_at: d.expires_at });
    token = d.token; role = d.role; userId = d.id;
    showWorkbench();
    await Promise.all([loadCounterparties(), refreshList(), refreshAmendments()]);
  } catch (err) {
    loginErr.textContent = err.message;
    loginErr.hidden = false;
  }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 会话失效也照常本地清理 */ }
  clearSession();
  token = ''; role = ''; userId = '';
  showLogin();
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
        <td>${esc(c.currency || 'CNY')}</td>
        <td>${badge(c.status)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5">暂无合同</td></tr>';
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
    <dt>金额（元）</dt><dd class="money">${money(c.amount)} <span class="muted">${esc(c.currency || 'CNY')}</span></dd>
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

async function loadCounterparties() {
  counterparties = await api('/api/counterparties');
  // 选择器提示 name + 信用代码 + 风险；管理页表格渲染。
  $('cp-select').innerHTML = counterparties.map((c) =>
    `<option value="${c.id}">${esc(c.name)}${c.credit_code ? ` · ${esc(c.credit_code)}` : ''}${c.risk_rating ? `（风险 ${esc(c.risk_rating)}）` : ''}</option>`).join('');
  renderCounterparties();
  renderAmendmentParent();
}

function renderCounterparties() {
  $('cp-list').innerHTML = counterparties.length
    ? counterparties.map((c) => `<tr data-id="${c.id}">
        <td>${esc(c.name)}</td>
        <td>${esc(c.credit_code || '—')}</td>
        <td>${esc(c.risk_rating || 'C')}</td>
        <td>${esc(c.contact || '—')}</td>
        <td class="row-actions">
          <button type="button" class="btn" data-act="edit">编辑</button>
          <button type="button" class="btn danger" data-act="del">删除</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="5">暂无相对方</td></tr>';
  document.querySelectorAll('#cp-list tr[data-id]').forEach((tr) => {
    tr.querySelector('[data-act="edit"]').addEventListener('click', () => startEditCp(tr.dataset.id));
    tr.querySelector('[data-act="del"]').addEventListener('click', () => deleteCp(tr.dataset.id));
  });
}

function startEditCp(id) {
  const c = counterparties.find((x) => x.id === id);
  if (!c) return;
  cpEditingId = id;
  const f = $('cp-form');
  f.name.value = c.name;
  f.credit_code.value = c.credit_code || '';
  f.risk_rating.value = c.risk_rating || 'C';
  f.contact.value = c.contact || '';
  $('cp-submit').textContent = '保存修改';
  hideCpError();
}

async function deleteCp(id) {
  if (!window.confirm('删除该相对方？')) return;
  try {
    await api(`/api/counterparties/${id}`, { method: 'DELETE' });
    await loadCounterparties();
  } catch (err) { showCpError(err.message); }
}

function showCpError(m) { const el = $('cp-error'); el.textContent = m; el.hidden = false; }
function hideCpError() { $('cp-error').hidden = true; }

async function submitCp(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    name: f.get('name'),
    credit_code: f.get('credit_code'),
    risk_rating: f.get('risk_rating'),
    contact: f.get('contact') || undefined,
  };
  try {
    if (cpEditingId) { await api(`/api/counterparties/${cpEditingId}`, { method: 'PATCH', body }); cpEditingId = null; $('cp-submit').textContent = '新增相对方'; }
    else { await api('/api/counterparties', { method: 'POST', body }); }
    e.target.reset();
    hideCpError();
    await loadCounterparties();
  } catch (err) { showCpError(err.message); } // 409 重复信用代码在此呈现
}

// —— 变更单：列表 + 详情对照 + 提交/审批/应用（只展示，服务端强校验兜底）。——
async function renderAmendmentParent() {
  const parents = await api('/api/contracts').catch(() => []); // 列表已默认收敛 superseded
  $('am-parent').innerHTML = parents.filter((c) => c.status === 'active')
    .map((c) => `<option value="${c.id}">v${c.version ?? 1} · ${esc(c.title)}</option>`).join('');
}

async function refreshAmendments() {
  amendments = await api('/api/amendments');
  $('am-list').innerHTML = amendments.length
    ? amendments.map((a) => `<tr data-id="${a.id}">
        <td>${esc((a.reason || '').slice(0, 14))}</td>
        <td>${esc(a.parent_contract_id)}</td>
        <td>${badge(a.status)}</td>
        <td><button type="button" class="btn" data-act="det">详情</button></td>
      </tr>`).join('')
    : '<tr><td colspan="4">暂无变更单</td></tr>';
  document.querySelectorAll('#am-list tr[data-id]').forEach((tr) => {
    tr.querySelector('[data-act="det"]').addEventListener('click', () => loadAmDetail(tr.dataset.id).catch((e) => flash(e.message)));
  });
}

async function submitAm(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const field = f.get('field');
  let value = f.get('value');
  if (field === 'amount') value = Math.round(Number(value || 0) * 100); // 元→分
  const parent_contract_id = f.get('parent_contract_id');
  if (!parent_contract_id) { flash('请先选择父合同'); return; }
  try {
    await api('/api/amendments', { method: 'POST', body: { parent_contract_id, reason: f.get('reason'), changes: { [field]: value } } });
    e.target.reset();
    await refreshAmendments();
  } catch (err) { flash(err.message); }
}

async function loadAmDetail(id) {
  const a = await api(`/api/amendments/${id}`);
  amSelectedId = id;
  $('am-detail').hidden = false;
  const fmt = (d, v) => (d === 'amount' ? money(v) : v == null ? '—' : esc(v));
  $('am-comparison').innerHTML = (a.comparison || []).length
    ? a.comparison.map((d) => `<dt>${esc(d.field)}</dt><dd>${fmt(d.field, d.from)} → ${fmt(d.field, d.to)}</dd>`).join('')
    : '<dt>—</dt><dd>无变更</dd>';
  // 仅展示对应的下一步动作；角色/合法性由服务端判定
  $('am-submit').hidden = a.status !== 'draft';
  $('am-approve').hidden = a.status !== 'in_review' || role === 'viewer';
  $('am-reject').hidden = a.status !== 'in_review' || role === 'viewer';
  $('am-apply').hidden = a.status !== 'approved' || role === 'viewer';
}

// —— 全文搜索：只读；分组渲染合同命中（可点入详情）与相对方命中。——
async function runSearch(raw) {
  const q = String(raw || '').trim();
  const out = $('search-results');
  if (!q) {
    out.innerHTML = '<p class="muted">输入关键词后回车搜索（子串，跨合同 + 相对方）</p>';
    return;
  }
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q));
    const cps = new Map(counterparties.map((c) => [c.id, c.name]));
    const cRows = d.contracts.length
      ? d.contracts.map((c) => `<tr data-id="${c.id}" class="clickable">
          <td>合同</td><td>${esc(c.title)}</td><td>${esc(cps.get(c.counterparty_id) || c.counterparty_id)}</td>
          <td class="money">${money(c.amount)}</td><td>${esc(c.currency || 'CNY')}</td><td>${badge(c.status)}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="muted">无匹配合同</td></tr>';
    const cpRows = d.counterparties.length
      ? d.counterparties.map((cp) => `<tr>
          <td>相对方</td><td>${esc(cp.name)}</td><td>${esc(cp.credit_code || '—')}</td>
          <td>${esc(cp.risk_rating || 'C')}</td><td colspan="2">${esc(cp.contact || '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="muted">无匹配相对方</td></tr>';
    out.innerHTML = `
      <div class="search-group"><h3>合同（${d.contracts.length}）</h3>
        <table class="contract-table"><thead><tr><th>类型</th><th>标题</th><th>相对方</th><th>金额（元）</th><th>币种</th><th>状态</th></tr></thead><tbody>${cRows}</tbody></table></div>
      <div class="search-group"><h3>相对方（${d.counterparties.length}）</h3>
        <table class="contract-table"><thead><tr><th>类型</th><th>名称</th><th>信用代码</th><th>风险</th><th colspan="2">联系人</th></tr></thead><tbody>${cpRows}</tbody></table></div>`;
    document.querySelectorAll('#search-results tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => loadDetail(tr.dataset.id).catch((e) => flash(e.message)));
    });
  } catch (err) { flash(err.message); }
}

async function amAction(action) {
  if (!amSelectedId) return;
  const body = (action === 'approve' || action === 'reject') ? { comment: (window.prompt('审批意见') || '').trim() } : undefined;
  try {
    await api(`/api/amendments/${amSelectedId}/${action}`, { method: 'POST', body });
    if (action === 'apply') flash('已应用，生成继任合同');
    await refreshList();
    await refreshAmendments();
    if (amSelectedId) loadAmDetail(amSelectedId).catch(() => {});
  } catch (err) { flash(err.message); }
}

async function init() {
  $('login-form').addEventListener('submit', doLogin);
  $('logout').addEventListener('click', doLogout);
  $('refresh').addEventListener('click', () => refreshList().catch((e) => flash(e.message)));
  $('close-detail').addEventListener('click', () => { $('detail-panel').hidden = true; selected = null; });
  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(new FormData(e.target).get('q')); });

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
          currency: f.get('currency') || 'CNY',
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

  $('cp-form').addEventListener('submit', (e) => submitCp(e).catch(() => {}));
  $('am-form').addEventListener('submit', (e) => submitAm(e).catch((err) => flash(err.message)));
  $('am-submit').addEventListener('click', () => amAction('submit'));
  $('am-approve').addEventListener('click', () => amAction('approve'));
  $('am-reject').addEventListener('click', () => amAction('reject'));
  $('am-apply').addEventListener('click', () => amAction('apply'));

  const s = readSession();
  if (s && s.token) {
    token = s.token; role = s.role; userId = s.id;
    showWorkbench();
    await loadCounterparties();
    await refreshList();
    await refreshAmendments();
  } else {
    showLogin();
  }
}

init().catch((e) => flash(e.message));