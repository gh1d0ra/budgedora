// Budgedora front-end. Vanilla JS + Chart.js.
(function () {
  'use strict';
  const S = window.Smart;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    user: null, buckets: [], expenses: [], tab: 'add',
    selectedBucket: null, userPickedBucket: false,
    period: null, periodKey: 'this-month', showArchived: false,
  };
  const charts = {};
  let money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

  // ---------- utils ----------
  const fmt = (n) => money.format(n || 0);
  const fmtShort = (n) => (Math.abs(n) >= 1000 ? new Intl.NumberFormat(undefined, { style: 'currency', currency: state.user?.currency || 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmt(n));
  const fmtDate = (s) => {
    const d = S.parseYmd(s), t = new Date();
    const y = S.ymd(S.addDays(t, -1));
    if (s === S.ymd(t)) return 'Today';
    if (s === y) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
  };
  const bucketById = (id) => state.buckets.find((b) => b.id === id);
  const activeBuckets = () => state.buckets.filter((b) => !b.archived);
  const ctx = () => ({ buckets: state.buckets, expenses: state.expenses, fmt, fmtDate, esc, bucketById, expectedFor, today: new Date() });
  // Month plan: per-month override, else the bucket's default monthly budget, else null (not budgeted).
  let budgetMap = new Map();
  const indexBudgets = () => { budgetMap = new Map(state.budgets.map((x) => [`${x.bucketId}|${x.month}`, x.amount])); };
  const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  function expectedFor(b, key) {
    const o = budgetMap.get(`${b.id}|${key}`);
    return o !== undefined ? o : b.monthlyBudget ?? null;
  }
  const store = {
    get(k) { try { return localStorage.getItem(`bd:${state.user?.id}:${k}`); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`bd:${state.user?.id}:${k}`, v); } catch { /* ignore */ } },
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
    return data;
  }

  let toastTimer;
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = () => { el.hidden = true; action.fn(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2600);
  }

  const sortExpenses = () => state.expenses.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

  // ---------- auth ----------
  let authMode = 'login';
  const resetToken = () => (location.hash.match(/^#reset=([0-9a-f]{64})$/) || [])[1];
  function showAuth() {
    $('#app').hidden = true;
    $('#auth').hidden = false;
    const resetting = !!resetToken();
    $('#resetForm').hidden = !resetting;
    $('#authForm').hidden = resetting;
    $('.seg').hidden = resetting;
    (resetting ? $('#resetForm [name=password]') : $('#authForm [name=email]')).focus();
  }
  $('#forgotBtn').addEventListener('click', () => { $('#forgotInfo').hidden = !$('#forgotInfo').hidden; });
  $('#resetCancel').addEventListener('click', () => { history.replaceState(null, '', location.pathname); showAuth(); });
  $('#resetForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const err = $('#resetError');
    err.hidden = true;
    if (f.password.value !== f.password2.value) { err.textContent = 'The two passwords don’t match.'; err.hidden = false; return; }
    try {
      await api('POST', '/api/reset', { token: resetToken(), password: f.password.value });
      f.reset();
      history.replaceState(null, '', location.pathname);
      await load();
      toast('Password changed — you’re signed in');
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  $$('[data-auth]').forEach((b) => b.addEventListener('click', () => {
    authMode = b.dataset.auth;
    $$('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
    $$('.signup-only').forEach((x) => (x.hidden = authMode !== 'signup'));
    $$('.login-only').forEach((x) => (x.hidden = authMode !== 'login'));
    $('#forgotInfo').hidden = true;
    $('#authSubmit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
    $('#authForm [name=password]').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
    $('#authError').hidden = true;
  }));
  $('#authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(ev.target));
    const btn = $('#authSubmit');
    btn.disabled = true;
    try {
      await api('POST', authMode === 'signup' ? '/api/signup' : '/api/login', fd);
      ev.target.reset();
      await load();
    } catch (err) {
      $('#authError').textContent = err.message;
      $('#authError').hidden = false;
    } finally { btn.disabled = false; }
  });

  $('#demoBtn').addEventListener('click', async () => {
    const btn = $('#demoBtn');
    btn.disabled = true;
    btn.textContent = 'Setting up the demo…';
    try {
      await api('POST', '/api/demo');
      await load();
      toast('Welcome to the demo — look around, change anything');
    } catch (err) {
      $('#authError').textContent = err.message;
      $('#authError').hidden = false;
    } finally { btn.disabled = false; btn.textContent = '👀 Try the demo'; }
  });

  async function load() {
    if (resetToken()) return showAuth();
    try {
      const data = await api('GET', '/api/data');
      state.user = data.user;
      state.buckets = data.buckets;
      state.expenses = data.expenses;
      state.budgets = data.budgets || [];
      indexBudgets();
    } catch (err) {
      if (err.status === 401) return showAuth();
      throw err;
    }
    money = new Intl.NumberFormat(undefined, { style: 'currency', currency: state.user.currency });
    $('#curSymbol').textContent = money.formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
    $('#auth').hidden = true;
    $('#app').hidden = false;
    $('#userName').textContent = state.user.name;
    $('#demoBanner').hidden = !state.user.isDemo;
    state.periodKey = store.get('periodKey') || 'this-month';
    if (!$('#date').value) setDate(S.ymd(new Date()));
    switchTab(location.hash.slice(1) || 'add', true);
    renderAll();
  }

  // ---------- tabs ----------
  function switchTab(tab, silent) {
    if (!['add', 'history', 'budget', 'reports', 'settings'].includes(tab)) tab = 'add';
    state.tab = tab;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${tab}`));
    if (!silent) history.replaceState(null, '', `#${tab}`);
    renderTab();
    if (tab === 'add' && matchMedia('(hover: hover)').matches) $('#amount').focus();
    window.scrollTo(0, 0);
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) switchTab(g.dataset.goto); });

  function renderAll() {
    renderBucketGrid();
    renderTab();
  }
  function renderTab() {
    if (!state.user) return;
    if (state.tab === 'add') { renderBucketGrid(); renderMonthCard(); renderRecent(); }
    if (state.tab === 'history') renderHistory();
    if (state.tab === 'reports') renderReports();
    if (state.tab === 'budget') renderBudget();
    if (state.tab === 'settings') renderSettings();
  }

  // ---------- ADD ----------
  function monthSpend() {
    const p = S.preset('this-month', state.expenses);
    const map = new Map();
    state.expenses.filter((e) => S.inP(e, p)).forEach((e) => map.set(e.bucketId, (map.get(e.bucketId) || 0) + e.amount));
    return map;
  }

  function renderBucketGrid() {
    const spend = monthSpend();
    const curKey = monthKey();
    const grid = $('#bucketGrid');
    grid.innerHTML = activeBuckets().map((b) => {
      const s = spend.get(b.id) || 0;
      const exp = expectedFor(b, curKey);
      const ratio = exp ? Math.min(1, Math.max(0, s / exp)) : 0;
      const sub = exp ? `${fmtShort(s)} / ${fmtShort(exp)}` : s ? `${fmtShort(s)} this month` : '&nbsp;';
      return `<button type="button" role="radio" class="bucket-btn${state.selectedBucket === b.id ? ' selected' : ''}${state.selectedBucket === b.id && !state.userPickedBucket ? ' suggested' : ''}"
        style="--c:${esc(b.color)}" data-id="${b.id}" aria-checked="${state.selectedBucket === b.id}">
        <span class="bi">${esc(b.icon || '•')}</span><span class="bn">${esc(b.name)}</span><span class="bs">${sub}</span>
        ${exp ? `<span class="bar${s > exp ? ' over' : ''}" style="width:${ratio * 100}%"></span>` : ''}
      </button>`;
    }).join('') || '<p class="muted">No buckets yet — add some in the Buckets tab.</p>';
  }
  $('#bucketGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.bucket-btn');
    if (!b) return;
    const id = Number(b.dataset.id);
    state.selectedBucket = id;
    state.userPickedBucket = true;
    renderBucketGrid();
    // If amount already typed, pressing a bucket is the last required step — move focus to Save.
    if (S.evalAmount($('#amount').value)) $('#saveBtn').focus();
  });

  function setDate(s) {
    $('#date').value = s;
    const t = new Date();
    $$('#dateChips .chip').forEach((c) => c.classList.toggle('active', S.ymd(S.addDays(t, Number(c.dataset.day))) === s));
  }
  $('#dateChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (c) setDate(S.ymd(S.addDays(new Date(), Number(c.dataset.day))));
  });
  $('#date').addEventListener('change', (e) => setDate(e.target.value));

  function sizeAmount() {
    const v = $('#amount').value || $('#amount').placeholder;
    $('#amount').style.width = `${Math.max(4, v.length + 0.6)}ch`;
  }
  sizeAmount();
  $('#amount').addEventListener('input', () => {
    sizeAmount();
    const raw = $('#amount').value;
    const v = S.evalAmount(raw);
    $('#amountHint').innerHTML = v != null && /[+\-*/]/.test(raw.replace(/^-/, '')) ? `= ${fmt(v)}` : '&nbsp;';
    syncRefund();
    const sug = S.suggestFromAmount(v, ctx()).filter((s) => bucketById(s.bucketId) && !bucketById(s.bucketId).archived);
    const box = $('#smartSuggest');
    box.hidden = !sug.length;
    box.innerHTML = sug.map((s, i) => { const b = bucketById(s.bucketId); return `<button type="button" class="chip" data-i="${i}">✨ ${esc(s.note || b.name)} · ${esc(b.icon)} ${esc(b.name)}</button>`; }).join('');
    box.onclick = (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      const s = sug[Number(c.dataset.i)];
      state.selectedBucket = s.bucketId; state.userPickedBucket = true;
      $('#note').value = s.note;
      box.hidden = true;
      renderBucketGrid();
      $('#saveBtn').focus();
    };
  });

  // Refunds: phone number pads often have no minus key, so a toggle flips the sign.
  let refund = false;
  function syncRefund() {
    const v = S.evalAmount($('#amount').value);
    const isNeg = refund || (v != null && v < 0);
    $('#refundBtn').classList.toggle('active', isNeg);
    $('#refundBtn').setAttribute('aria-pressed', String(isNeg));
    $('#saveBtn').textContent = isNeg ? 'Save refund' : 'Save expense';
  }
  $('#refundBtn').addEventListener('click', () => { refund = !refund; syncRefund(); $('#amount').focus(); });

  $('#note').addEventListener('input', () => {
    if (state.userPickedBucket) return;
    const b = S.suggestBucket($('#note').value, ctx());
    state.selectedBucket = b ? b.id : null;
    renderBucketGrid();
  });

  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let amount = S.evalAmount($('#amount').value);
    if (!amount) { toast('Enter an amount first'); $('#amount').focus(); return; }
    if (refund) amount = -Math.abs(amount);
    if (!state.selectedBucket) { toast('Pick a bucket'); $('#bucketGrid').scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    const body = { amount, bucketId: state.selectedBucket, date: $('#date').value || S.ymd(new Date()), note: $('#note').value.trim() };
    $('#saveBtn').disabled = true;
    try {
      const exp = await api('POST', '/api/expenses', body);
      state.expenses.push(exp); sortExpenses();
      const b = bucketById(exp.bucketId);
      $('#amount').value = ''; sizeAmount(); $('#note').value = ''; $('#amountHint').innerHTML = '&nbsp;'; $('#smartSuggest').hidden = true;
      state.selectedBucket = null; state.userPickedBucket = false; refund = false; syncRefund();
      renderTab();
      toast(`${exp.amount < 0 ? 'Refund ' : ''}${fmt(exp.amount)} → ${b.icon} ${b.name}`, { label: 'Undo', fn: () => removeExpense(exp.id) });
      $('#amount').focus();
    } catch (err) { toast(err.message); } finally { $('#saveBtn').disabled = false; }
  });

  async function removeExpense(id) {
    await api('DELETE', `/api/expenses/${id}`);
    state.expenses = state.expenses.filter((e) => e.id !== id);
    renderTab();
  }

  function renderMonthCard() {
    const t = new Date();
    const p = S.preset('this-month', state.expenses);
    const list = state.expenses.filter((e) => S.inP(e, p));
    const total = S.sum(list);
    // same point last month, for a fair comparison
    const lmFrom = S.ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1));
    const lmTo = S.ymd(new Date(t.getFullYear(), t.getMonth() - 1, Math.min(t.getDate(), new Date(t.getFullYear(), t.getMonth(), 0).getDate())));
    const lmSame = S.sum(state.expenses.filter((e) => e.date >= lmFrom && e.date <= lmTo));
    const budget = state.buckets.reduce((s, b) => s + (expectedFor(b, monthKey(t)) || 0), 0);
    const byB = [...monthSpend().entries()].map(([id, v]) => ({ b: bucketById(id), v })).filter((x) => x.b && x.v > 0).sort((a, b) => b.v - a.v);
    const stackTotal = byB.reduce((s, x) => s + x.v, 0);
    let cmp = '';
    if (lmSame) {
      const d = Math.round(((total - lmSame) / lmSame) * 100);
      cmp = `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span> vs same point last month`;
    }
    $('#monthCard').innerHTML = `
      <div class="mc-top"><div><div class="muted small">${S.MONTHS[t.getMonth()]} so far</div><div class="mc-total">${fmt(total)}</div></div>
      <div class="mc-sub" style="text-align:right">${cmp}${budget ? `<div>${fmt(Math.max(0, budget - total))} left of ${fmt(budget)} budget</div>` : ''}</div></div>
      ${stackTotal ? `<div class="stack">${byB.map((x) => `<span title="${esc(x.b.name)} ${fmt(x.v)}" style="width:${(x.v / stackTotal) * 100}%;background:${esc(x.b.color)}"></span>`).join('')}</div>
      <div class="legend">${byB.slice(0, 6).map((x) => `<span><i class="dot" style="background:${esc(x.b.color)}"></i>${esc(x.b.name)} ${fmtShort(x.v)}</span>`).join('')}</div>` : '<p class="muted small" style="margin:8px 0 0">Nothing logged this month yet.</p>'}`;
  }

  function txHtml(e) {
    const b = bucketById(e.bucketId) || { icon: '•', name: '?', color: '#888' };
    return `<li class="tx" data-id="${e.id}" style="--c:${esc(b.color)}">
      <span class="ti">${esc(b.icon || '•')}</span>
      <span class="tm"><div class="tn">${esc(e.note || b.name)}</div><div class="td">${esc(b.name)} · ${fmtDate(e.date)}</div></span>
      <span class="ta${e.amount < 0 ? ' refund' : ''}">${e.amount < 0 ? '↩ ' : ''}${fmt(e.amount)}</span></li>`;
  }
  function renderRecent() {
    $('#recentList').innerHTML = state.expenses.slice(0, 6).map(txHtml).join('') || '<li class="empty">Your expenses will show up here.</li>';
  }
  document.addEventListener('click', (e) => { const tx = e.target.closest('.tx[data-id]'); if (tx) openEdit(Number(tx.dataset.id)); });

  // ---------- edit dialog ----------
  let editingId = null;
  function openEdit(id) {
    const e = state.expenses.find((x) => x.id === id);
    if (!e) return;
    editingId = id;
    const f = $('#editForm');
    f.bucketId.innerHTML = state.buckets.filter((b) => !b.archived || b.id === e.bucketId).map((b) => `<option value="${b.id}">${esc(b.icon)} ${esc(b.name)}</option>`).join('');
    f.amount.value = e.amount; f.bucketId.value = e.bucketId; f.date.value = e.date; f.note.value = e.note;
    $('#editDialog').showModal();
  }
  $('#editDialog').addEventListener('close', async () => {
    const action = $('#editDialog').returnValue;
    const f = $('#editForm');
    if (!editingId) return;
    const id = editingId; editingId = null;
    try {
      if (action === 'delete') {
        const old = state.expenses.find((x) => x.id === id);
        await removeExpense(id);
        toast('Expense deleted', { label: 'Undo', fn: async () => { const re = await api('POST', '/api/expenses', old); state.expenses.push(re); sortExpenses(); renderTab(); } });
      } else if (action === 'save') {
        const upd = await api('PUT', `/api/expenses/${id}`, { amount: S.evalAmount(f.amount.value), bucketId: Number(f.bucketId.value), date: f.date.value, note: f.note.value });
        state.expenses = state.expenses.map((x) => (x.id === id ? upd : x)); sortExpenses();
        renderTab(); toast('Saved');
      }
    } catch (err) { toast(err.message); }
  });

  // ---------- HISTORY ----------
  function renderHistory() {
    const sel = $('#histBucket'), cur = sel.value;
    sel.innerHTML = '<option value="">All buckets</option>' + state.buckets.map((b) => `<option value="${b.id}">${esc(b.icon)} ${esc(b.name)}</option>`).join('');
    sel.value = cur;
    const ms = $('#histMonth'), curM = ms.value;
    const months = [...new Set(state.expenses.map((e) => e.date.slice(0, 7)))];
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    ms.innerHTML = '<option value="">All dates</option>' + years.map((y) => `<optgroup label="${y}"><option value="${y}">All of ${y}</option>${months.filter((m) => m.startsWith(y)).map((m) => `<option value="${m}">${S.MONTHS[Number(m.slice(5)) - 1]} ${y}</option>`).join('')}</optgroup>`).join('');
    ms.value = curM;

    const q = $('#histSearch').value.trim().toLowerCase();
    let min = null, max = null, text = q, mm;
    if ((mm = q.match(/>\s*(\d+(?:\.\d+)?)/))) { min = Number(mm[1]); text = text.replace(mm[0], ''); }
    if ((mm = q.match(/<\s*(\d+(?:\.\d+)?)/))) { max = Number(mm[1]); text = text.replace(mm[0], ''); }
    text = text.trim();
    const list = state.expenses.filter((e) => {
      if (sel.value && e.bucketId !== Number(sel.value)) return false;
      if (ms.value && !e.date.startsWith(ms.value)) return false;
      if (min != null && e.amount <= min) return false;
      if (max != null && e.amount >= max) return false;
      if (text) {
        const b = bucketById(e.bucketId);
        const hay = `${e.note} ${b?.name || ''} ${e.amount.toFixed(2)} ${e.date}`.toLowerCase();
        if (!text.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    $('#histSummary').textContent = `${list.length} expense${list.length === 1 ? '' : 's'} · ${fmt(S.sum(list))}`;
    const groups = new Map();
    list.slice(0, 1500).forEach((e) => { const k = e.date.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
    $('#histList').innerHTML = [...groups.entries()].map(([k, arr]) => `
      <div class="month-group"><h4><span>${S.MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}</span><span>${fmt(S.sum(arr))}</span></h4>
      <ul class="tx-list">${arr.map(txHtml).join('')}</ul></div>`).join('') || '<p class="empty">No matching expenses.</p>';
  }
  ['#histSearch', '#histBucket', '#histMonth'].forEach((s) => $(s).addEventListener('input', renderHistory));

  // ---------- REPORTS ----------
  const PRESETS = [['this-month', 'This month'], ['last-month', 'Last month'], ['last-3', '3 months'], ['this-year', 'This year'], ['last-year', 'Last year'], ['last-12', '12 months'], ['all', 'All time']];
  const EXAMPLES = ['groceries last year', 'restaurants vs groceries this year', 'top expenses in march', 'average monthly utilities', 'car/gas 2025 vs 2024', 'how many times restaurants last 3 months', 'vacation since 2023', 'over 200 this year'];

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const SERIES = ['#0f766e', '#f59e0b', '#6366f1', '#ec4899', '#0ea5e9', '#84cc16'];

  function chart(id, config) {
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (!el || !window.Chart) return;
    Chart.defaults.color = cssVar('--muted');
    Chart.defaults.borderColor = cssVar('--border');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    charts[id] = new Chart(el, config);
  }
  const moneyTicks = { callback: (v) => fmtShort(v) };
  const tipMoney = { callbacks: { label: (c) => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt(c.parsed.y ?? c.parsed.x ?? c.parsed)}` } };

  function currentPeriod() {
    if (state.periodKey.startsWith('y:')) {
      const [, y, m] = state.periodKey.split(':');
      return m === '' || m === undefined ? S.P.year(Number(y)) : S.P.month(Number(y), Number(m));
    }
    return S.preset(state.periodKey, state.expenses) || S.preset('this-month', state.expenses);
  }
  function setPeriod(key) {
    state.periodKey = key; store.set('periodKey', key);
    renderReports();
  }

  function renderReports() {
    // controls
    $('#periodChips').innerHTML = PRESETS.map(([k, l]) => `<button class="chip${state.periodKey === k ? ' active' : ''}" data-p="${k}">${l}</button>`).join('');
    const years = [...new Set([new Date().getFullYear(), ...state.expenses.map((e) => Number(e.date.slice(0, 4)))])].sort((a, b) => b - a);
    const [, py, pm] = state.periodKey.startsWith('y:') ? state.periodKey.split(':') : [];
    $('#periodYear').innerHTML = '<option value="">Pick year…</option>' + years.map((y) => `<option ${String(y) === py ? 'selected' : ''}>${y}</option>`).join('');
    $('#periodMonth').innerHTML = '<option value="">Whole year</option>' + S.MONTHS.map((m, i) => `<option value="${i}" ${pm === String(i) ? 'selected' : ''}>${m}</option>`).join('');
    $('#periodMonth').disabled = !py;
    $('#askExamples').innerHTML = EXAMPLES.map((x) => `<button class="chip" type="button">${esc(x)}</button>`).join('');

    const p = currentPeriod();
    const today = S.ymd(new Date());
    let prev = S.previous(p);
    // Period still in progress → compare against the same elapsed slice of the previous period (fair "to date" comparison).
    const inProgress = prev && p.from <= today && p.to > today;
    if (inProgress) {
      const elapsed = Math.round((S.parseYmd(today) - S.parseYmd(p.from)) / 864e5);
      const cut = S.ymd(S.addDays(S.parseYmd(prev.from), elapsed));
      prev = { ...prev, to: cut < prev.to ? cut : prev.to };
    }
    const list = state.expenses.filter((e) => S.inP(e, p));
    const prevList = prev ? state.expenses.filter((e) => S.inP(e, prev)) : [];
    const total = S.sum(list), prevTotal = S.sum(prevList);
    const months = S.elapsedMonths(p);
    const vsLabel = inProgress ? 'same point last period' : 'previous period';
    const days = Math.max(1, Math.round((S.parseYmd(p.to < today ? p.to : today) - S.parseYmd(p.from)) / 864e5) + 1);
    $('#periodTitle').textContent = p.kind === 'all' ? `All time (${p.from.slice(0, 4)}–${p.to.slice(0, 4)})` : p.label;

    // KPIs
    const d = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
    const byB = new Map();
    list.forEach((e) => byB.set(e.bucketId, (byB.get(e.bucketId) || 0) + e.amount));
    const topB = [...byB.entries()].sort((a, b) => b[1] - a[1])[0];
    $('#kpis').innerHTML = [
      ['Total spent', fmt(total), d == null ? (prev ? 'nothing in previous period' : '') : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span> vs ${fmt(prevTotal)} (${vsLabel})`],
      [p.kind === 'month' ? 'Per day' : 'Per month', p.kind === 'month' ? fmt(total / days) : fmt(total / months), p.kind === 'month' ? `${days} day${days > 1 ? 's' : ''} so far` : `${months.toFixed(months % 1 ? 1 : 0)} months`],
      ['Expenses', String(list.length), list.length ? `avg ${fmt(total / list.length)} each` : ''],
      ['Top bucket', topB ? `${esc(bucketById(topB[0])?.icon || '')} ${fmtShort(topB[1])}` : '—', topB ? esc(bucketById(topB[0])?.name) : ''],
    ].map(([l, v, s]) => `<div class="kpi"><div class="kl">${l}</div><div class="kv">${v}</div><div class="kd">${s}</div></div>`).join('');

    // insights
    $('#insights').innerHTML = `<h3>✨ Insights</h3><ul>${S.insights(p, ctx()).map((i) => `<li><span class="ii">${i.icon}</span><span>${i.html}</span></li>`).join('')}</ul>`;

    // donut
    const rows = state.buckets.map((b) => ({ b, v: byB.get(b.id) || 0 })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    chart('chDonut', {
      type: 'doughnut',
      data: { labels: rows.map((r) => r.b.name), datasets: [{ data: rows.map((r) => r.v), backgroundColor: rows.map((r) => r.b.color), borderColor: cssVar('--surface'), borderWidth: 2 }] },
      options: {
        maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(c.parsed)} (${Math.round((c.parsed / total) * 100)}%)` } } },
      },
    });

    // trend: daily cumulative for a month; monthly stacked bars otherwise
    if (p.kind === 'month' || days <= 45) {
      $('#trendTitle').textContent = 'Cumulative this period vs previous';
      const n = Math.round((S.parseYmd(p.to) - S.parseYmd(p.from)) / 864e5) + 1;
      const cum = (arr, from) => { let s = 0; const byDay = new Map(); arr.forEach((e) => { const k = Math.round((S.parseYmd(e.date) - S.parseYmd(from)) / 864e5); byDay.set(k, (byDay.get(k) || 0) + e.amount); }); return Array.from({ length: n }, (_, i) => (s += byDay.get(i) || 0)); };
      const curCum = cum(list, p.from);
      const todayIdx = Math.round((S.parseYmd(today) - S.parseYmd(p.from)) / 864e5);
      chart('chTrend', {
        type: 'line',
        data: {
          labels: Array.from({ length: n }, (_, i) => S.addDays(S.parseYmd(p.from), i).getDate()),
          datasets: [
            { label: 'This period', data: curCum.map((v, i) => (i <= todayIdx ? v : null)), borderColor: SERIES[0], backgroundColor: SERIES[0] + '22', fill: true, tension: 0.25, pointRadius: 0 },
            ...(prev ? [{ label: 'Previous', data: cum(prevList, prev.from), borderColor: cssVar('--muted'), borderDash: [5, 4], pointRadius: 0, tension: 0.25 }] : []),
          ],
        },
        options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: { ticks: moneyTicks, beginAtZero: true } }, plugins: { tooltip: tipMoney, legend: { labels: { boxWidth: 10 } } } },
      });
    } else {
      $('#trendTitle').textContent = 'Monthly spending by bucket';
      const ms = S.monthsIn(p);
      chart('chTrend', {
        type: 'bar',
        data: {
          labels: ms.map((m) => m.label),
          datasets: rows.map((r) => ({ label: r.b.name, backgroundColor: r.b.color, data: ms.map((m) => S.sum(list.filter((e) => e.bucketId === r.b.id && e.date.startsWith(m.key)))) })),
        },
        options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, ticks: moneyTicks } }, plugins: { legend: { display: false }, tooltip: { ...tipMoney, mode: 'index', filter: (i) => i.parsed.y > 0 } } },
      });
    }

    // bucket table
    const prevB = new Map();
    prevList.forEach((e) => prevB.set(e.bucketId, (prevB.get(e.bucketId) || 0) + e.amount));
    const tblRows = state.buckets.filter((b) => !b.archived || byB.get(b.id) || prevB.get(b.id))
      .map((b) => ({ b, v: byB.get(b.id) || 0, pv: prevB.get(b.id) || 0 })).sort((a, b) => b.v - a.v);
    const planMonths = S.monthsIn(p).filter((m) => m.key <= today.slice(0, 7));
    $('#bucketTable').innerHTML = `<thead><tr><th>Bucket</th><th>Spent</th><th>%</th><th>Avg / mo</th>${prev ? `<th>${inProgress ? 'Prev. to date' : 'Previous'}</th><th>Change</th>` : ''}<th>Budget</th></tr></thead>
      <tbody>${tblRows.map(({ b, v, pv }) => {
        const ch = pv ? Math.round(((v - pv) / pv) * 100) : null;
        const bud = planMonths.reduce((s, m) => s + (expectedFor(b, m.key) || 0), 0);
        return `<tr><td><i class="dot" style="background:${esc(b.color)}"></i>${esc(b.icon)} ${esc(b.name)}</td><td>${fmt(v)}</td><td>${total ? Math.round((v / total) * 100) : 0}%</td><td>${fmt(v / months)}</td>
          ${prev ? `<td class="muted">${fmt(pv)}</td><td>${ch == null ? (v ? '<span class="up">new</span>' : '—') : `<span class="${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${ch > 0 ? '+' : ''}${ch}%</span>`}</td>` : ''}
          <td>${bud ? `${fmtShort(v)} / ${fmtShort(bud)}<span class="budget-bar"><i class="${v > bud ? 'over' : ''}" style="width:${Math.min(100, (v / bud) * 100)}%"></i></span>` : '<span class="muted">—</span>'}</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td>Total</td><td>${fmt(total)}</td><td>100%</td><td>${fmt(total / months)}</td>${prev ? `<td class="muted">${fmt(prevTotal)}</td><td>${d == null ? '—' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}%</span>`}</td>` : ''}<td></td></tr></tfoot>`;

    // year over year
    const allYears = [...new Set(state.expenses.map((e) => Number(e.date.slice(0, 4))))].sort().slice(-5);
    chart('chYoy', {
      type: 'line',
      data: {
        labels: S.MON,
        datasets: allYears.map((y, i) => ({
          label: String(y), tension: 0.3, pointRadius: 3,
          borderColor: SERIES[(allYears.length - 1 - i) % SERIES.length], backgroundColor: SERIES[(allYears.length - 1 - i) % SERIES.length],
          borderWidth: y === new Date().getFullYear() ? 3 : 2,
          data: S.MON.map((_, m) => { const k = `${y}-${String(m + 1).padStart(2, '0')}`; return k > today.slice(0, 7) ? null : S.sum(state.expenses.filter((e) => e.date.startsWith(k))); }),
        })),
      },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: { ticks: moneyTicks, beginAtZero: true } }, plugins: { tooltip: tipMoney, legend: { labels: { boxWidth: 10 } } } },
    });

    // years × months pivot
    const yrs = [...new Set(state.expenses.map((e) => Number(e.date.slice(0, 4))))].sort((a, b) => b - a);
    const ym = new Map();
    state.expenses.forEach((e) => ym.set(e.date.slice(0, 7), (ym.get(e.date.slice(0, 7)) || 0) + e.amount));
    const maxCell = Math.max(1, ...ym.values());
    const heat = (v) => (v ? `background:color-mix(in srgb, var(--accent) ${Math.round(8 + (v / maxCell) * 45)}%, transparent)` : '');
    $('#pivotYM').innerHTML = yrs.length ? `<thead><tr><th>Year</th>${S.MON.map((m) => `<th>${m}</th>`).join('')}<th>Total</th><th>Avg/mo</th></tr></thead><tbody>${yrs.map((y) => {
      const vals = S.MON.map((_, m) => ym.get(`${y}-${String(m + 1).padStart(2, '0')}`) || 0);
      const tot = vals.reduce((a, b) => a + b, 0);
      const active = vals.filter(Boolean).length || 1;
      return `<tr><td class="cell" data-y="${y}"><b>${y}</b></td>${vals.map((v, m) => `<td class="cell ${v ? '' : 'zero'}" data-y="${y}" data-m="${m}" style="${heat(v)}">${v ? fmtShort(v) : '–'}</td>`).join('')}<td><b>${fmtShort(tot)}</b></td><td>${fmtShort(tot / active)}</td></tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td class="empty">No data yet</td></tr></tbody>';

    // buckets × months for the period's year
    const by = p.kind === 'month' || p.kind === 'year' ? p.y : Number(p.to.slice(0, 4));
    $('#pivotBMTitle').innerHTML = `Buckets × months — ${by} <span class="muted small">— click a cell to see those expenses</span>`;
    const yearList = state.expenses.filter((e) => e.date.startsWith(String(by)));
    const bmRows = state.buckets.map((b) => ({ b, vals: S.MON.map((_, m) => S.sum(yearList.filter((e) => e.bucketId === b.id && e.date.slice(5, 7) === String(m + 1).padStart(2, '0')))) }))
      .filter((r) => r.vals.some(Boolean));
    const bmMax = Math.max(1, ...bmRows.flatMap((r) => r.vals));
    const heat2 = (v, c) => (v ? `background:color-mix(in srgb, ${c} ${Math.round(8 + (v / bmMax) * 50)}%, transparent)` : '');
    $('#pivotBM').innerHTML = bmRows.length ? `<thead><tr><th>Bucket</th>${S.MON.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead><tbody>${bmRows.map((r) =>
      `<tr><td>${esc(r.b.icon)} ${esc(r.b.name)}</td>${r.vals.map((v, m) => `<td class="cell ${v ? '' : 'zero'}" data-b="${r.b.id}" data-y="${by}" data-m="${m}" style="${heat2(v, esc(r.b.color))}">${v ? fmtShort(v) : '–'}</td>`).join('')}<td><b>${fmtShort(r.vals.reduce((a, b) => a + b, 0))}</b></td></tr>`).join('')}</tbody>` : `<tbody><tr><td class="empty">No expenses in ${by}</td></tr></tbody>`;

    // top + day of week
    $('#topList').innerHTML = [...list].sort((a, b) => b.amount - a.amount).slice(0, 8).map(txHtml).join('') || '<li class="empty">Nothing here.</li>';
    const dowNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dow = Array(7).fill(0);
    list.forEach((e) => { dow[(S.parseYmd(e.date).getDay() + 6) % 7] += e.amount; });
    chart('chDow', {
      type: 'bar',
      data: { labels: dowNames, datasets: [{ label: 'Spent', data: dow, backgroundColor: dow.map((_, i) => (i >= 5 ? SERIES[1] : SERIES[0])), borderRadius: 6 }] },
      options: { maintainAspectRatio: false, scales: { y: { ticks: moneyTicks, beginAtZero: true } }, plugins: { legend: { display: false }, tooltip: tipMoney } },
    });
  }

  $('#periodChips').addEventListener('click', (e) => { const c = e.target.closest('[data-p]'); if (c) setPeriod(c.dataset.p); });
  $('#periodYear').addEventListener('change', (e) => { if (e.target.value) setPeriod(`y:${e.target.value}:`); });
  $('#periodMonth').addEventListener('change', (e) => { const y = $('#periodYear').value; if (y) setPeriod(`y:${y}:${e.target.value}`); });
  $('#pivotYM').addEventListener('click', (e) => {
    const c = e.target.closest('.cell'); if (!c) return;
    setPeriod(`y:${c.dataset.y}:${c.dataset.m ?? ''}`);
    $('#periodTitle').scrollIntoView({ behavior: 'smooth' });
  });
  $('#pivotBM').addEventListener('click', (e) => {
    const c = e.target.closest('.cell[data-b]'); if (!c) return;
    switchTab('history');
    $('#histBucket').value = c.dataset.b;
    $('#histMonth').value = `${c.dataset.y}-${String(Number(c.dataset.m) + 1).padStart(2, '0')}`;
    $('#histSearch').value = '';
    renderHistory();
  });

  // Ask
  function ask(text) {
    $('#askInput').value = text;
    const q = S.parseQuery(text, ctx());
    const a = S.answer(q, ctx());
    $('#askResult').innerHTML = `<div class="card answer"><div class="headline">${a.headline}</div><div class="understood">${esc(a.understood)}</div>
      ${a.chart ? '<div class="chart-box"><canvas id="chAsk"></canvas></div>' : ''}
      ${a.list && a.list.length ? `<ul class="tx-list">${a.list.map(txHtml).join('')}</ul>` : ''}</div>`;
    if (a.chart) {
      const c = a.chart;
      chart('chAsk', {
        type: 'bar',
        data: {
          labels: c.labels,
          datasets: [
            ...c.datasets.map((d, i) => ({ label: d.label, data: d.data, backgroundColor: d.colors || d.color || SERIES[(d.colorIndex ?? i) % SERIES.length], borderRadius: 5 })),
            ...(c.avgLine ? [{ type: 'line', label: 'Average', data: c.labels.map(() => c.avgLine), borderColor: cssVar('--muted'), borderDash: [5, 4], pointRadius: 0 }] : []),
          ],
        },
        options: {
          indexAxis: c.horizontal ? 'y' : 'x', maintainAspectRatio: false,
          scales: c.horizontal ? { x: { ticks: moneyTicks } } : { y: { ticks: moneyTicks, beginAtZero: true } },
          plugins: { legend: { display: c.datasets.length > 1 || !!c.avgLine, labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (t) => `${t.dataset.label}: ${fmt(c.horizontal ? t.parsed.x : t.parsed.y)}` } } },
        },
      });
    }
  }
  $('#askForm').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#askInput').value.trim(); if (t) ask(t); });
  $('#askExamples').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) ask(c.textContent); });

  // ---------- BUDGET: expected vs actual ----------
  state.budMonth = monthKey();
  state.budScope = 'month';
  const keyLabel = (key) => `${S.MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
  const shiftKey = (key, n) => monthKey(new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1 + n, 1));

  /** Expected / actual / remaining / over for every relevant bucket in one month. */
  function monthPlan(key) {
    const spent = new Map();
    state.expenses.forEach((e) => { if (e.date.startsWith(key)) spent.set(e.bucketId, (spent.get(e.bucketId) || 0) + e.amount); });
    const rows = state.buckets
      .map((b) => {
        const exp = expectedFor(b, key);
        const actual = spent.get(b.id) || 0;
        return {
          b, exp, actual, custom: budgetMap.has(`${b.id}|${key}`),
          remaining: exp == null ? null : Math.max(0, exp - actual),
          over: exp == null ? null : Math.max(0, actual - exp),
        };
      })
      .filter((r) => !r.b.archived || r.actual || r.exp);
    const t = {
      expected: rows.reduce((s, r) => s + (r.exp || 0), 0),
      actual: rows.reduce((s, r) => s + r.actual, 0),
      remaining: rows.reduce((s, r) => s + (r.remaining || 0), 0),
      over: rows.reduce((s, r) => s + (r.over || 0), 0),
      unbudgeted: rows.filter((r) => r.exp == null).reduce((s, r) => s + r.actual, 0),
    };
    return { rows, t };
  }

  function renderBudget() {
    const key = state.budMonth;
    const curKey = monthKey();
    $('#budMonthTitle').textContent = keyLabel(key);
    $('#budToday').hidden = key === curKey;
    $$('[data-scope]').forEach((x) => x.classList.toggle('active', x.dataset.scope === state.budScope));
    const { rows, t } = monthPlan(key);

    const used = t.expected ? Math.round((t.actual / t.expected) * 100) : null;
    let pace = '';
    if (key === curKey) {
      const now = new Date(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      pace = `${Math.round((now.getDate() / dim) * 100)}% of the month gone`;
    }
    const net = t.expected - t.actual;
    $('#budKpis').innerHTML = [
      ['Expected', fmt(t.expected), `${rows.filter((r) => r.exp != null).length} budgeted buckets`],
      ['Actual', fmt(t.actual), used == null ? 'no plan yet' : `${used}% of plan used${pace ? ' · ' + pace : ''}`],
      ['Over budget', `<span class="${t.over ? 'up' : ''}">${fmt(t.over)}</span>`, `${rows.filter((r) => r.over > 0).length} bucket(s) over`],
      ['Remaining', `<span class="${t.remaining ? 'down' : ''}">${fmt(t.remaining)}</span>`, `Net ${net >= 0 ? 'under' : 'over'} plan: <b class="${net >= 0 ? 'down' : 'up'}">${fmt(Math.abs(net))}</b>`],
    ].map(([l, v, s]) => `<div class="kpi"><div class="kl">${l}</div><div class="kv">${v}</div><div class="kd">${s}</div></div>`).join('');

    $('#budTable').innerHTML = `<thead><tr><th>Bucket</th><th>Expected</th><th>Actual</th><th>Remaining</th><th>Over budget</th><th class="bar-col"></th></tr></thead>
      <tbody>${rows.map((r) => {
        const pct = r.exp ? Math.min(100, (r.actual / r.exp) * 100) : 0;
        const def = r.b.monthlyBudget;
        return `<tr data-id="${r.b.id}">
          <td><i class="dot" style="background:${esc(r.b.color)}"></i>${esc(r.b.icon)} ${esc(r.b.name)}</td>
          <td class="exp-cell"><input class="exp-in" inputmode="decimal" value="${r.exp ?? ''}" placeholder="—" aria-label="Expected for ${esc(r.b.name)}">
            ${r.custom ? `<button class="icon-btn reset-exp" type="button" title="Use the every-month amount (${def == null ? 'none' : fmt(def)})">↺</button>` : ''}</td>
          <td data-label="Actual">${fmt(r.actual)}</td>
          <td data-label="Remaining" class="${r.remaining ? 'down' : 'muted'}">${r.remaining == null ? '—' : fmt(r.remaining)}</td>
          <td data-label="Over" class="${r.over ? 'up' : 'muted'}">${r.over == null ? '—' : fmt(r.over)}</td>
          <td class="bar-col">${r.exp ? `<span class="budget-bar wide"><i class="${r.actual > r.exp ? 'over' : ''}" style="width:${pct}%"></i></span>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="exp-cell">${fmt(t.expected)}</td><td data-label="Actual">${fmt(t.actual)}</td><td data-label="Remaining" class="down">${fmt(t.remaining)}</td><td data-label="Over" class="up">${fmt(t.over)}</td><td class="bar-col"></td></tr></tfoot>`;
    $('#budNote').innerHTML = [
      t.unbudgeted ? `${fmt(t.unbudgeted)} was spent in buckets without an expected amount (not counted in Remaining/Over).` : '',
      `<b>Change this month only</b> sets ${keyLabel(key)} alone. <b>Change every month</b> updates the default for all months you haven't customized (customized ones show ↺).`,
    ].filter(Boolean).join('<br>');

    const year = key.slice(0, 4);
    $('#budYearTitle').textContent = `${year} — expected vs actual`;
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const yr = months.map((k) => ({ k, ...monthPlan(k).t, future: k > curKey }));
    const sumF = (f) => yr.reduce((s, m) => s + (m.future ? 0 : m[f]), 0);
    const netCell = (v) => `<td class="${v >= 0 ? 'down' : 'up'}">${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}</td>`;
    $('#budYear').innerHTML = `<thead><tr><th>Month</th><th>Expected</th><th>Actual</th><th>Over budget</th><th>Remaining</th><th>Net</th></tr></thead>
      <tbody>${yr.map((m) => `<tr class="cell-row${m.k === key ? ' current' : ''}" data-k="${m.k}">
        <td><b>${S.MONTHS[Number(m.k.slice(5)) - 1]}</b></td>
        <td>${fmt(m.expected)}</td>
        <td>${m.future && !m.actual ? '<span class="muted">—</span>' : fmt(m.actual)}</td>
        <td class="${m.over ? 'up' : 'muted'}">${m.future ? '—' : fmt(m.over)}</td>
        <td class="${m.remaining ? 'down' : 'muted'}">${m.future ? '—' : fmt(m.remaining)}</td>
        ${m.future ? '<td class="muted">—</td>' : netCell(m.expected - m.actual)}
      </tr>`).join('')}</tbody>
      <tfoot><tr><td>Total so far</td><td>${fmt(sumF('expected'))}</td><td>${fmt(sumF('actual'))}</td><td class="up">${fmt(sumF('over'))}</td><td class="down">${fmt(sumF('remaining'))}</td>${netCell(sumF('expected') - sumF('actual'))}</tr></tfoot>`;
  }

  function applyBudgetRows(month, rows) {
    state.budgets = state.budgets.filter((x) => x.month !== month).concat(rows);
    indexBudgets();
  }
  async function saveExpected(bucketId, amount) {
    const key = state.budMonth;
    if (state.budScope === 'default') {
      const upd = await api('PUT', `/api/buckets/${bucketId}`, { monthlyBudget: amount });
      state.buckets = state.buckets.map((b) => (b.id === bucketId ? upd : b));
      // this month follows the new default too
      if (budgetMap.has(`${bucketId}|${key}`)) applyBudgetRows(key, await api('PUT', '/api/budgets', { month: key, items: [{ bucketId, amount: null }] }));
    } else {
      applyBudgetRows(key, await api('PUT', '/api/budgets', { month: key, items: [{ bucketId, amount: amount ?? 0 }] }));
    }
  }

  $('#budPrev').addEventListener('click', () => { state.budMonth = shiftKey(state.budMonth, -1); renderBudget(); });
  $('#budNext').addEventListener('click', () => { state.budMonth = shiftKey(state.budMonth, 1); renderBudget(); });
  $('#budToday').addEventListener('click', () => { state.budMonth = monthKey(); renderBudget(); });
  $$('[data-scope]').forEach((x) => x.addEventListener('click', () => { state.budScope = x.dataset.scope; renderBudget(); }));
  $('#budYear').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    state.budMonth = tr.dataset.k; renderBudget();
    $('#budMonthTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#budTable').addEventListener('change', async (e) => {
    const inp = e.target.closest('.exp-in'); if (!inp) return;
    const id = Number(inp.closest('tr').dataset.id);
    const raw = inp.value.trim();
    const v = raw === '' ? null : S.evalAmount(raw);
    if (raw !== '' && (v == null || v < 0)) { toast('Enter an amount of 0 or more (or leave empty)'); return renderBudget(); }
    try {
      await saveExpected(id, v);
      renderBudget(); renderBucketGrid();
      toast(state.budScope === 'default' ? 'Saved for every month' : `Saved for ${keyLabel(state.budMonth)}`);
    } catch (err) { toast(err.message); renderBudget(); }
  });
  $('#budTable').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList.contains('exp-in')) return;
    e.preventDefault();
    const all = $$('.exp-in', $('#budTable'));
    const idx = all.indexOf(e.target);
    e.target.blur(); // triggers change → re-render; refocus the next row afterwards
    setTimeout(() => { const next = $$('.exp-in', $('#budTable'))[idx + 1]; if (next) { next.focus(); next.select(); } }, 50);
  });
  $('#budTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('.reset-exp'); if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    try {
      applyBudgetRows(state.budMonth, await api('PUT', '/api/budgets', { month: state.budMonth, items: [{ bucketId: id, amount: null }] }));
      renderBudget(); renderBucketGrid();
    } catch (err) { toast(err.message); }
  });
  $('#budCopy').addEventListener('click', async () => {
    const key = state.budMonth, prev = shiftKey(key, -1);
    const items = state.buckets.filter((b) => !b.archived).map((b) => ({ bucketId: b.id, amount: expectedFor(b, prev) }));
    if (!items.some((i) => i.amount != null)) return toast(`${keyLabel(prev)} has no plan to copy`);
    if (state.budgets.some((x) => x.month === key) && !confirm(`Replace ${keyLabel(key)}'s plan with ${keyLabel(prev)}'s?`)) return;
    try {
      // amounts equal to the default are stored as "use default" so later default changes still flow through
      const body = items.map((i) => ({ bucketId: i.bucketId, amount: i.amount === (bucketById(i.bucketId).monthlyBudget ?? null) ? null : i.amount ?? 0 }));
      applyBudgetRows(key, await api('PUT', '/api/budgets', { month: key, items: body }));
      renderBudget(); renderBucketGrid();
      toast(`Copied ${keyLabel(prev)}'s plan`);
    } catch (err) { toast(err.message); }
  });

  // ---------- SETTINGS ----------
  function renderSettings() {
    const list = state.buckets.filter((b) => state.showArchived || !b.archived);
    $('#bucketEdit').innerHTML = list.map((b, i) => `
      <li data-id="${b.id}" class="${b.archived ? 'archived' : ''}">
        <input class="icon-in" data-f="icon" value="${esc(b.icon)}" maxlength="4" aria-label="Icon">
        <input data-f="name" value="${esc(b.name)}" maxlength="60" aria-label="Name">
        <input data-f="color" type="color" value="${esc(b.color)}" aria-label="Color">
        <input class="budget-in" data-f="monthlyBudget" inputmode="decimal" placeholder="Budget / mo" value="${b.monthlyBudget ?? ''}" aria-label="Monthly budget">
        <span class="acts">
          <button class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="down" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
          ${b.archived ? '<button class="icon-btn" data-act="restore" title="Restore">↺</button>' : '<button class="icon-btn" data-act="delete" title="Delete / archive">🗑</button>'}
        </span>
      </li>`).join('');
    const f = $('#accountForm');
    f.name.value = state.user.name;
    f.currency.value = state.user.currency;
    $('#adminCard').hidden = !state.user.isAdmin;
    if (state.user.isAdmin) renderAdmin();
  }

  // ---------- admin: family accounts ----------
  async function renderAdmin() {
    try {
      const users = await api('GET', '/api/admin/users');
      $('#adminTable').innerHTML = `<thead><tr><th>Account</th><th>Status</th><th>Expenses</th><th>Last entry</th><th></th></tr></thead><tbody>${users.map((u) => `
        <tr data-id="${u.id}" data-email="${esc(u.email)}">
          <td><b>${esc(u.name)}</b>${u.isAdmin ? ' 👑' : ''}<div class="muted small">${esc(u.email)}</div></td>
          <td>${u.deletedAt ? '<span class="badge del">Deleted</span>' : u.locked ? '<span class="badge lock">Locked</span>' : '<span class="badge ok">Active</span>'}</td>
          <td>${u.expenses}</td>
          <td>${u.lastExpense ? fmtDate(u.lastExpense) : '—'}</td>
          <td class="acts-cell">
            ${u.deletedAt ? '<button class="btn small-btn" data-admin="restore">Restore</button>' : ''}
            ${u.locked ? '<button class="btn small-btn" data-admin="unlock">Unlock</button>' : ''}
            <button class="btn small-btn" data-admin="reset-link">Reset link</button>
          </td></tr>`).join('')}</tbody>`;
    } catch (err) { $('#adminTable').innerHTML = `<tbody><tr><td class="error">${esc(err.message)}</td></tr></tbody>`; }
  }
  $('#adminRefresh').addEventListener('click', renderAdmin);
  $('#backupNow').addEventListener('click', async () => {
    const btn = $('#backupNow');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/admin/backup');
      $('#backupStatus').textContent = `✅ Saved ${r.key} — ${r.users} accounts, ${r.expenses} expenses (${Math.round(r.bytes / 1024)} KB, kept 180 days).`;
    } catch (err) { $('#backupStatus').textContent = `❌ Backup failed: ${err.message}`; }
    finally { btn.disabled = false; }
  });
  $('#adminTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-admin]'); if (!btn) return;
    const tr = btn.closest('tr');
    const act = btn.dataset.admin;
    if (act === 'restore' && !confirm(`Restore ${tr.dataset.email}? They'll be able to sign in again with their old password.`)) return;
    try {
      const r = await api('POST', `/api/admin/users/${tr.dataset.id}/${act}`);
      if (act === 'reset-link') {
        const box = $('#resetLinkBox');
        box.hidden = false;
        box.innerHTML = `<p>One-time reset link for <b>${esc(r.email)}</b> (valid ${r.expiresInHours} h). Send it to them privately:</p>
          <div class="row gap"><input readonly value="${esc(r.link)}" id="resetLinkInput"><button class="btn primary" type="button" id="copyReset">Copy</button></div>`;
        $('#copyReset').onclick = async () => {
          try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch { $('#resetLinkInput').select(); }
        };
      } else {
        toast(act === 'restore' ? 'Account restored' : 'Account unlocked');
        renderAdmin();
      }
    } catch (err) { toast(err.message); }
  });

  // ---------- delete account (3 steps; soft delete) ----------
  const del = $('#deleteDialog');
  function delStep(n) { $$('[data-step]', del).forEach((s) => (s.hidden = s.dataset.step !== String(n))); del.dataset.step = n; }
  $('#deleteAccountBtn').addEventListener('click', () => {
    $('#deleteForm').reset(); $('#deleteError').hidden = true;
    $('#deleteEmail').textContent = state.user.email;
    delStep(1); del.showModal();
  });
  del.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]')) return del.close();
    if (!e.target.closest('[data-next]')) return;
    const f = $('#deleteForm');
    if (del.dataset.step === '1') {
      if (!f.understand.checked) return toast('Tick “I understand” to continue');
      delStep(2); f.password.focus();
    } else if (del.dataset.step === '2') {
      const err = $('#deleteError');
      if (!f.password.value) { err.textContent = 'Enter your password.'; err.hidden = false; return; }
      if (f.confirm.value.trim() !== 'DELETE') { err.textContent = 'Type DELETE (in capitals) to confirm.'; err.hidden = false; return; }
      delStep(3);
    }
  });
  $('#deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/account/delete', { password: f.password.value, confirm: f.confirm.value.trim() });
      del.close();
      state.user = null; state.expenses = []; state.buckets = [];
      showAuth();
      toast('Account deleted. Ask the family admin if you ever want it back.');
    } catch (err) { delStep(2); $('#deleteError').textContent = err.message; $('#deleteError').hidden = false; }
  });

  // ---------- Excel import (read in the browser, reviewed before saving) ----------
  const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  const MONTH_RE = /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\s*(\d{2}|\d{4})\s*$/i;
  const SKIP_HEADER = /^(month|date|total|totals|income|income avg|expected expenses|expenses|overbudget|over budget|remaining|budget|sum|notes?)$/i;
  let xlsxPlan = null;

  function loadScript(src, global = 'XLSX', what = 'Excel') {
    return new Promise((resolve, reject) => {
      if (window[global]) return resolve();
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load the ${what} reader. Check your connection.`));
      document.head.appendChild(s);
    });
  }
  const stemW = (w) => w.toLowerCase().replace(/[^a-z]/g, '').replace(/ies$/, 'y').replace(/s$/, '');
  /** Best existing bucket for an Excel column header (first word counts double), or null. */
  function guessBucket(header) {
    const words = header.split(/[^A-Za-z]+/).map(stemW).filter((w) => w.length >= 3);
    let best = null, bestScore = 0;
    for (const b of state.buckets) {
      const bw = new Set(b.name.split(/[^A-Za-z]+/).map(stemW).filter((w) => w.length >= 3));
      const score = words.reduce((s, w, i) => s + (bw.has(w) ? (i === 0 ? 2 : 1) : 0), 0);
      if (score > bestScore) { best = b; bestScore = score; }
    }
    return best;
  }

  function parseWorkbook(wb) {
    const months = [], skipped = [];
    const headers = new Map(); // header → {rows, total}
    for (const name of wb.SheetNames) {
      const m = name.match(MONTH_RE);
      if (!m) { skipped.push(name); continue; }
      const mi = S.MON.findIndex((x) => m[1].toLowerCase().startsWith(x.toLowerCase()));
      const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      const ws = wb.Sheets[name];
      if (!ws['!ref']) { skipped.push(name); continue; }
      const range = XLSX.utils.decode_range(ws['!ref']);
      // header row = first row with at least 2 text cells
      let hr = -1;
      for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 10) && hr < 0; r++) {
        let txt = 0;
        for (let c = range.s.c; c <= range.e.c; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 's' && String(cell.v).trim()) txt++; }
        if (txt >= 2) hr = r;
      }
      if (hr < 0) { skipped.push(name); continue; }
      const cols = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: hr, c })];
        const h = cell ? String(cell.v).replace(/\s+/g, ' ').trim() : '';
        if (h) cols.push({ c, h });
      }
      const entries = [];
      for (let r = hr + 1; r <= range.e.r; r++) {
        for (const { c, h } of cols) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (!cell) continue;
          if (cell.f && /\b(SUM|SUBTOTAL|AVERAGE|TOTAL)\s*\(/i.test(cell.f)) continue; // totals rows
          let v = cell.t === 'n' ? cell.v : (cell.t === 's' && /^\s*-?\$?\d+(\.\d+)?\s*$/.test(cell.v) ? Number(String(cell.v).replace(/[$\s]/g, '')) : null);
          if (v == null || !Number.isFinite(v) || Math.abs(v) < 0.005) continue;
          v = Math.round(v * 100) / 100;
          entries.push({ h, amount: v });
          const hs = headers.get(h) || { rows: 0, total: 0 };
          hs.rows++; hs.total += v; headers.set(h, hs);
        }
      }
      months.push({ sheet: name, y, m: mi, key: `${y}-${String(mi + 1).padStart(2, '0')}`, entries });
    }
    months.sort((a, b) => (a.key < b.key ? -1 : 1));
    return { months, skipped, headers };
  }

  function renderXlsxPlan() {
    const p = xlsxPlan;
    const opts = (sel) => `<option value="__skip" ${sel === '__skip' ? 'selected' : ''}>— Skip this column —</option>` +
      state.buckets.filter((b) => !b.archived).map((b) => `<option value="${b.id}" ${String(sel) === String(b.id) ? 'selected' : ''}>${esc(b.icon)} ${esc(b.name)}</option>`).join('');
    const mapRows = [...p.headers.entries()].map(([h, s]) => {
      const sel = p.map.get(h);
      return `<tr><td><b>${esc(h)}</b></td><td>${s.rows}</td><td>${fmt(s.total)}</td>
        <td><select data-h="${esc(h)}">${opts(sel)}<option value="__new" ${sel === '__new' ? 'selected' : ''}>➕ New bucket “${esc(h)}”</option></select></td></tr>`;
    }).join('');
    const existing = (key) => S.sum(state.expenses.filter((e) => e.date.startsWith(key)));
    const monthRows = p.months.map((mo, i) => {
      const kept = mo.entries.filter((e) => p.map.get(e.h) !== '__skip');
      const ex = existing(mo.key);
      return `<tr><td><label class="toggle"><input type="checkbox" data-mi="${i}" ${mo.on ? 'checked' : ''}> ${S.MONTHS[mo.m]} ${mo.y}</label></td>
        <td class="muted">${esc(mo.sheet)}</td><td>${kept.length}</td><td><b>${fmt(kept.reduce((s, e) => s + e.amount, 0))}</b></td>
        <td>${ex ? `<span class="up">already ${fmt(ex)} in app</span>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join('');
    const on = p.months.filter((mo) => mo.on);
    const count = on.reduce((s, mo) => s + mo.entries.filter((e) => p.map.get(e.h) !== '__skip').length, 0);
    $('#xlsxBody').innerHTML = `
      <p class="muted small">Found <b>${p.months.length}</b> month sheets${p.skipped.length ? ` · skipped: ${p.skipped.map(esc).join(', ')}` : ''}. Each amount becomes one expense dated the <b>1st of its month</b>; negative amounts are saved as refunds.</p>
      <h4>1 · Match your columns to buckets</h4>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Excel column</th><th>Rows</th><th>Total</th><th>Bucket</th></tr></thead><tbody>${mapRows}</tbody></table></div>
      <h4>2 · Check the month totals against your sheet</h4>
      <div class="table-wrap scroll-y"><table class="tbl"><thead><tr><th>Month</th><th>Sheet</th><th>Rows</th><th>Total</th><th></th></tr></thead><tbody>${monthRows}</tbody></table></div>
      <p class="small"><b>${count}</b> expenses from <b>${on.length}</b> months will be imported.</p>`;
    $('#xlsxImport').textContent = `Import ${count} expenses`;
    $('#xlsxImport').disabled = !count;
  }

  $('#xlsxFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = '';
    try {
      toast('Reading your workbook…');
      await loadScript(XLSX_URL);
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: true });
      const parsed = parseWorkbook(wb);
      if (!parsed.months.length) return toast('No month sheets found (expected names like “Aug 26”).');
      const map = new Map();
      for (const h of parsed.headers.keys()) {
        const b = SKIP_HEADER.test(h) ? null : guessBucket(h);
        map.set(h, SKIP_HEADER.test(h) ? '__skip' : b ? b.id : '__new');
      }
      parsed.months.forEach((mo) => { mo.on = !state.expenses.some((x) => x.date.startsWith(mo.key)); });
      xlsxPlan = { ...parsed, map };
      $('#xlsxError').hidden = true;
      renderXlsxPlan();
      $('#xlsxDialog').showModal();
    } catch (err) { toast(err.message || 'Could not read that file'); }
  });
  $('#xlsxBody').addEventListener('change', (e) => {
    if (e.target.dataset.h !== undefined) xlsxPlan.map.set(e.target.dataset.h, /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value);
    if (e.target.dataset.mi !== undefined) xlsxPlan.months[Number(e.target.dataset.mi)].on = e.target.checked;
    renderXlsxPlan();
  });
  $('#xlsxCancel').addEventListener('click', () => $('#xlsxDialog').close());
  $('#xlsxImport').addEventListener('click', async () => {
    const p = xlsxPlan;
    const rows = [];
    for (const mo of p.months.filter((x) => x.on)) {
      for (const en of mo.entries) {
        const target = p.map.get(en.h);
        if (target === '__skip') continue;
        const bucket = target === '__new' ? en.h : bucketById(target)?.name;
        if (!bucket) continue;
        // keep the original column name as the note when it was merged into a differently named bucket
        const note = bucket.toLowerCase() === en.h.toLowerCase() ? '' : en.h;
        rows.push({ date: `${mo.key}-01`, bucket, amount: en.amount, note });
      }
    }
    const btn = $('#xlsxImport');
    btn.disabled = true;
    try {
      let added = 0;
      for (let i = 0; i < rows.length; i += 4000) {
        btn.textContent = `Importing… ${Math.round((i / rows.length) * 100)}%`;
        added += (await api('POST', '/api/expenses/import', { rows: rows.slice(i, i + 4000) })).added;
      }
      $('#xlsxDialog').close();
      state.periodKey = 'all'; store.set('periodKey', 'all');
      await load();
      state.periodKey = 'all';
      switchTab('reports');
      toast(`Imported ${added} expenses 🎉`);
    } catch (err) {
      $('#xlsxError').textContent = `${err.message} — nothing after this point was saved; check History before retrying.`;
      $('#xlsxError').hidden = false;
      btn.disabled = false; btn.textContent = 'Retry import';
    }
  });
  // ---------- Bank / card statement import (AMEX, Chase, Wells Fargo, any CSV/Excel/OFX; read in the browser) ----------
  const ST = window.Statements;
  let stmt = null; // { files: [{name, source, kind, count}], rows, view }
  const PDFJS = '/vendor/pdfjs-3.11.174/';
  /** Positioned text of every page of a PDF, read in the browser with pdf.js (self-hosted). */
  async function pdfPages(file) {
    await loadScript(PDFJS + 'pdf.min.js', 'pdfjsLib', 'PDF');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      pages.push(tc.items.map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, str: i.str })));
    }
    doc.destroy();
    return pages;
  }

  function renderAmazonUpdate() {
    const p = stmt, on = p.rows.filter((r) => r.on);
    $('#stmtBody').innerHTML = `
      <p class="muted small"><b>Amazon order history</b> · ${p.orders} orders. Matched <b>${p.rows.length}</b> of your ${p.candidates} Amazon expenses by amount and date — untick any that look wrong. Only the note changes; buckets stay as they are.</p>
      <div class="table-wrap scroll-y tall"><table class="tbl stmt-tbl"><thead><tr><th></th><th>Date</th><th>Note now → new note</th><th>Amount</th></tr></thead><tbody>
      ${p.rows.map((r, i) => `<tr class="${r.on ? '' : 'off'}"><td><input type="checkbox" data-on="${i}" ${r.on ? 'checked' : ''} aria-label="Update this expense"></td>
        <td>${esc(fmtDate(r.date))}</td><td class="desc"><span class="muted">${esc(r.old)}</span><br><span title="${esc(r.items.join('\n'))}">${esc(r.desc)}</span></td><td>${fmt(r.spend)}</td></tr>`).join('')}
      </tbody></table></div>`;
    const btn = $('#stmtImport');
    btn.textContent = `Update ${on.length} expenses`;
    btn.disabled = !on.length;
  }

  function renderStmt() {
    if (stmt.mode === 'update') return renderAmazonUpdate();
    const p = stmt;
    const opts = (sel) => `<option value="">— Pick a bucket —</option>` +
      activeBuckets().map((b) => `<option value="${b.id}" ${sel === b.id ? 'selected' : ''}>${esc(b.icon)} ${esc(b.name)}</option>`).join('');
    const main = p.rows.filter((r) => !r.skip && !r.dup), other = p.rows.filter((r) => r.skip || r.dup);
    const on = p.rows.filter((r) => r.on), need = on.filter((r) => !r.bucketId);
    const views = { main: ['To import', main], need: ['Needs a bucket', need], other: ['Skipped', other] };
    if (p.view === 'need' && !need.length) p.view = 'main';
    const list = views[p.view][1];
    const chips = Object.entries(views).map(([k, [label, arr]]) =>
      `<button type="button" class="chip ${p.view === k ? 'active' : ''}" data-view="${k}">${label} (${arr.length})</button>`).join('');
    const rowsHtml = list.slice(0, 1500).map((r) => {
      const i = p.rows.indexOf(r);
      const why = r.dup ? '<span class="badge lock">already in app</span>' : r.skip ? `<span class="badge del">${esc(r.skip)}</span>` : '';
      const sub = [p.files.length > 1 ? r.source : '', r.member, r.category].filter(Boolean).map(esc).join(' · ');
      return `<tr class="${r.on ? '' : 'off'}">
        <td><input type="checkbox" data-on="${i}" ${r.on ? 'checked' : ''} aria-label="Import this row"></td>
        <td>${esc(fmtDate(r.date))}</td>
        <td class="desc"><span title="${esc(r.items ? r.items.join('\n') : r.raw)}">${esc(r.desc)}</span> ${why}${sub ? `<div class="muted small">${sub}</div>` : ''}</td>
        <td class="${r.spend < 0 ? 'down' : ''}">${fmt(r.spend)}</td>
        <td><select data-b="${i}" class="${r.on && !r.bucketId ? 'need' : ''}">${opts(r.bucketId)}</select></td></tr>`;
    }).join('');
    const total = on.reduce((s, r) => s + r.spend, 0);
    const dates = p.rows.map((r) => r.date).sort();
    $('#stmtBody').innerHTML = `
      <p class="muted small">${p.files.map((f) => `<b>${esc(f.source)}</b>${f.kind === 'bank' ? ' checking' : f.kind === 'card' ? ' card' : ''} · ${esc(f.name)} · ${f.count} transactions${!f.check ? ''
        : f.check.ok ? ' · <span class="badge ok">✓ adds up to the statement totals</span>'
        : ` · <span class="badge del">⚠ read ${fmt(f.check.got)}, statement says ${fmt(f.check.expected)} — some lines may be missing</span>`}`).join('<br>')}
        ${dates.length ? `<br>${esc(fmtDate(dates[0]))} – ${esc(fmtDate(dates[dates.length - 1]))}` : ''}</p>
      ${p.amazon ? `<p class="small">📦 <b>Amazon:</b> ${p.amazon.matched} of ${p.amazon.candidates} Amazon charges matched to items from ${p.amazon.orders} orders${p.amazon.matched < p.amazon.candidates ? ' (the rest keep the bank’s description)' : ''}.</p>` : ''}
      <p class="muted small">Card payments, transfers and money coming in are skipped, and so is anything already in the app. Credits such as returns are saved as refunds. Picking a bucket for one row also sets it for the same merchant in the other rows.</p>
      <div class="chips stmt-chips">${chips}</div>
      <div class="table-wrap scroll-y tall"><table class="tbl stmt-tbl"><thead><tr><th></th><th>Date</th><th>Description</th><th>Amount</th><th>Bucket</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="5" class="muted">Nothing here.</td></tr>'}</tbody></table></div>
      <p class="small"><b>${on.length}</b> transactions · <b>${fmt(total)}</b> will be imported${need.length ? ` · <span class="up">${need.length} still need a bucket</span>` : ''}.</p>`;
    const btn = $('#stmtImport');
    btn.textContent = need.length ? `Pick buckets for ${need.length} more` : `Import ${on.length} transactions`;
    btn.disabled = !on.length || need.length > 0;
  }

  $('#stmtFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const parsed = [], problems = [], orders = new Map();
    const addAmazon = (p) => { for (const [k, o] of p.orders) orders.set(k, o); };
    for (const file of files) {
      try {
        let p;
        if (/\.zip$/i.test(file.name)) {
          // Amazon's "Your Orders" download: read the order CSVs straight out of the zip
          await loadScript(XLSX_URL);
          const zip = XLSX.CFB.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
          let found = 0;
          zip.FullPaths.forEach((path, i) => {
            const ent = zip.FileIndex[i];
            if (!ent || ent.type !== 2 || !/\.csv$/i.test(path)) return;
            const az = ST.parseAmazon(ST.parseCsv(new TextDecoder().decode(ent.content)));
            if (az) { addAmazon(az); found += az.orders.size; }
          });
          if (!found) throw new Error(`${file.name}: no Amazon order history found in this zip.`);
          continue;
        }
        if (/\.xlsx?$|\.xlsm$/i.test(file.name)) {
          await loadScript(XLSX_URL);
          const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
          p = ST.parseFile({ name: file.name, workbook: wb, XLSX });
        } else if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
          p = ST.parseFile({ name: file.name, pdfPages: await pdfPages(file) });
        } else {
          p = ST.parseFile({ name: file.name, text: await file.text() });
        }
        if (p.amazon) { addAmazon(p); continue; }
        if (!p.txns.length) throw new Error(`No transactions found in ${file.name}.`);
        parsed.push({ ...p, name: file.name });
      } catch (err) { problems.push(err.message || `Could not read ${file.name}`); }
    }
    if (!parsed.length && !orders.size) return toast(problems.join(' '));
    if (!parsed.length) {
      // Amazon file on its own: put product names on Amazon expenses already in the app
      const rows = state.expenses.filter((x) => ST.AMAZON_RE.test(x.note) && !/^(amazon|kindle)( return)?:/i.test(x.note))
        .map((x) => ({ id: x.id, date: x.date, spend: x.amount, raw: x.note, desc: x.note, old: x.note }));
      const res = ST.enrichAmazon(rows, orders, null);
      if (!res.matched) return toast(rows.length ? `None of your ${rows.length} Amazon expenses matched an order in that file (by amount and date).` : 'No Amazon expenses in the app yet — import your card statement together with the Amazon file.');
      stmt = { mode: 'update', orders: orders.size, rows: rows.filter((r) => r.amazon).map((r) => ({ ...r, on: true })), candidates: res.candidates };
    } else {
      const rows = ST.plan(parsed, { buckets: state.buckets, expenses: state.expenses });
      const az = orders.size ? ST.enrichAmazon(rows, orders, activeBuckets()) : null;
      stmt = {
        files: parsed.map((p) => ({ name: p.name, source: p.source, kind: p.kind, count: p.txns.length, check: p.check || null })),
        rows, view: 'main', amazon: az && { ...az, orders: orders.size },
      };
    }
    $('#stmtError').textContent = problems.join(' ');
    $('#stmtError').hidden = !problems.length;
    renderStmt();
    $('#stmtDialog').showModal();
  });
  $('#stmtBody').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.on !== undefined) stmt.rows[Number(t.dataset.on)].on = t.checked;
    if (t.dataset.b !== undefined) {
      const row = stmt.rows[Number(t.dataset.b)];
      const id = t.value ? Number(t.value) : null;
      row.bucketId = id; row.manual = true;
      if (id) row.on = true;
      // same merchant elsewhere in the statement → same bucket, unless the user already chose one there
      if (id && row.key && !row.amazon) stmt.rows.forEach((r) => { if (!r.manual && !r.amazon && r.key === row.key) r.bucketId = id; });
    }
    renderStmt();
  });
  $('#stmtBody').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]'); if (!v) return;
    stmt.view = v.dataset.view; renderStmt();
  });
  $('#stmtCancel').addEventListener('click', () => $('#stmtDialog').close());
  $('#stmtImport').addEventListener('click', async () => {
    if (stmt.mode === 'update') {
      const btn = $('#stmtImport'), todo = stmt.rows.filter((r) => r.on);
      btn.disabled = true;
      let done = 0;
      try {
        for (let i = 0; i < todo.length; i += 6) {
          btn.textContent = `Updating… ${Math.round((i / todo.length) * 100)}%`;
          await Promise.all(todo.slice(i, i + 6).map((r) => api('PUT', `/api/expenses/${r.id}`, { note: r.desc }).then(() => done++)));
        }
        $('#stmtDialog').close();
        await load();
        switchTab('history');
        toast(`Added product names to ${done} Amazon expenses 📦`);
      } catch (err) {
        $('#stmtError').textContent = `${err.message} — ${done} were updated; run it again to finish the rest.`;
        $('#stmtError').hidden = false;
        btn.disabled = false; btn.textContent = 'Retry';
      }
      return;
    }
    const rows = stmt.rows.filter((r) => r.on && r.bucketId).map((r) => ({ date: r.date, bucket: bucketById(r.bucketId).name, amount: r.spend, note: r.desc }));
    const btn = $('#stmtImport');
    btn.disabled = true;
    try {
      let added = 0;
      for (let i = 0; i < rows.length; i += 4000) {
        btn.textContent = `Importing… ${Math.round((i / rows.length) * 100)}%`;
        added += (await api('POST', '/api/expenses/import', { rows: rows.slice(i, i + 4000) })).added;
      }
      $('#stmtDialog').close();
      await load();
      switchTab('history');
      toast(`Imported ${added} transactions 🎉`);
    } catch (err) {
      $('#stmtError').textContent = `${err.message} — nothing after this point was saved; check History before retrying.`;
      $('#stmtError').hidden = false;
      btn.disabled = false; btn.textContent = 'Retry import';
    }
  });

  $('#showArchived').addEventListener('change', (e) => { state.showArchived = e.target.checked; renderSettings(); });

  $('#bucketEdit').addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-f]'); if (!inp) return;
    const id = Number(inp.closest('li').dataset.id);
    try {
      const upd = await api('PUT', `/api/buckets/${id}`, { [inp.dataset.f]: inp.dataset.f === 'monthlyBudget' ? (S.evalAmount(inp.value) || null) : inp.value });
      state.buckets = state.buckets.map((b) => (b.id === id ? upd : b));
      renderBucketGrid();
      toast('Bucket updated');
    } catch (err) { toast(err.message); }
  });
  $('#bucketEdit').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = Number(btn.closest('li').dataset.id);
    const b = bucketById(id);
    try {
      if (btn.dataset.act === 'up' || btn.dataset.act === 'down') {
        const ids = state.buckets.map((x) => x.id);
        const i = ids.indexOf(id), j = btn.dataset.act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        state.buckets = ids.map(bucketById);
        renderSettings();
        await api('PUT', '/api/buckets/order', { ids });
      } else if (btn.dataset.act === 'delete') {
        const used = state.expenses.some((x) => x.bucketId === id);
        if (!confirm(used ? `“${b.name}” has expenses, so it will be archived (hidden from entry, kept in reports). Continue?` : `Delete “${b.name}”?`)) return;
        const r = await api('DELETE', `/api/buckets/${id}`);
        state.buckets = r.archived ? state.buckets.map((x) => (x.id === id ? { ...x, archived: true } : x)) : state.buckets.filter((x) => x.id !== id);
        if (state.selectedBucket === id) state.selectedBucket = null;
        renderSettings(); renderBucketGrid();
      } else if (btn.dataset.act === 'restore') {
        const upd = await api('PUT', `/api/buckets/${id}`, { archived: false });
        state.buckets = state.buckets.map((x) => (x.id === id ? upd : x));
        renderSettings(); renderBucketGrid();
      }
    } catch (err) { toast(err.message); }
  });
  $('#newBucketForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      const b = await api('POST', '/api/buckets', fd);
      state.buckets.push(b);
      e.target.reset();
      renderSettings(); renderBucketGrid();
      toast(`Added ${b.name}`);
    } catch (err) { toast(err.message); }
  });
  $('#accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      state.user = await api('PUT', '/api/me', fd);
      e.target.currentPassword.value = ''; e.target.newPassword.value = '';
      money = new Intl.NumberFormat(undefined, { style: 'currency', currency: state.user.currency });
      $('#curSymbol').textContent = money.formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
      $('#userName').textContent = state.user.name;
      toast('Account saved');
    } catch (err) { toast(err.message); }
  });
  async function signOut() {
    await api('POST', '/api/logout');
    state.user = null; state.expenses = []; state.buckets = [];
    showAuth();
  }
  $('#logoutBtn').addEventListener('click', signOut);
  $('#demoSignup').addEventListener('click', async () => {
    await signOut();
    $('[data-auth=signup]').click();
  });

  function parseCsv(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const rows = parseCsv(await file.text());
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (n) => head.indexOf(n);
    const hasHead = idx('date') >= 0;
    const [di, bi, ai, ni] = hasHead ? [idx('date'), idx('bucket') >= 0 ? idx('bucket') : idx('category'), idx('amount'), idx('note')] : [0, 1, 2, 3];
    const data = (hasHead ? rows.slice(1) : rows).map((r) => ({ date: (r[di] || '').trim(), bucket: r[bi], amount: Number(String(r[ai]).replace(/[^\d.-]/g, '')), note: ni >= 0 ? r[ni] : '' }));
    try {
      const r = await api('POST', '/api/expenses/import', { rows: data });
      toast(`Imported ${r.added} expenses${r.skipped ? `, skipped ${r.skipped}` : ''}`);
      await load();
    } catch (err) { toast(err.message); }
    e.target.value = '';
  });

  // keyboard: "n" jumps to a new entry from anywhere
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && state.user) {
      e.preventDefault(); switchTab('add');
    }
  });
  window.addEventListener('hashchange', () => state.user && switchTab(location.hash.slice(1), true));

  load().catch((err) => { console.error(err); toast('Could not reach the server'); });
})();
