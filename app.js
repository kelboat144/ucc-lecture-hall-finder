const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toM = (t) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const KIND = { online: 'Online', cancelled: 'Cancelled', postponed: 'Postponed' };
const ROLE = { super: 'Super Admin', main: 'Main Admin', delegated: 'Delegated Admin', pr: 'Programme Rep' };
const RANK = { super: 4, main: 3, delegated: 2, pr: 1 };
let me = null, data = { halls: [], classes: [], moved: [], bookings: [], pending: [] }, tab = 'free', openHall = null, postId = null, view = 'vFind', pollTimer = null, lockTimer = null;
const has = (k) => me && (me.role === 'super' || me.role === 'main' || (me.perms || []).includes(k));
const isStaff = () => me && me.role !== 'pr';

async function api(url, method = 'GET', body) {
  if (method !== 'GET' && body === undefined) body = {};
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error(j.error || 'Please sign in again.'); }
  if (res.status === 403 && j.must_change) { showApp(); throw new Error(j.error); }
  if (!res.ok) { const err = new Error(j.error || 'Request failed.'); Object.assign(err, { details: j.details, retry: j.retry_after }); throw err; }
  return j;
}
const say = (id, text, ok) => { const el = $(id); if (!el) return; el.textContent = text; el.className = 'msg' + (el.classList.contains('wide') ? ' wide' : '') + (text ? (ok ? ' ok' : ' err') : ''); };
const ask = (q, def) => { const v = prompt(q, def || ''); return v === null ? null : v.trim(); };

// ---------- theme + glass ----------
function applyTheme(t) { document.documentElement.dataset.theme = t; document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#081226' : '#0f2a4f'; }
let savedTheme = null; try { savedTheme = localStorage.getItem('theme'); } catch (e) {}
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeBtn').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(t); try { localStorage.setItem('theme', t); } catch (e) {} });
function applyGlass(on) { document.documentElement.dataset.glass = on ? 'on' : 'off'; $('glassToggle').checked = on; }
let savedGlass = null; try { savedGlass = localStorage.getItem('glass'); } catch (e) {}
applyGlass(savedGlass !== 'off');
$('glassToggle').addEventListener('change', (e) => { applyGlass(e.target.checked); try { localStorage.setItem('glass', e.target.checked ? 'on' : 'off'); } catch (err) {} });

// show / hide password buttons
document.addEventListener('click', (e) => {
  if (!e.target.dataset.eye) return;
  const inp = e.target.previousElementSibling, show = inp.type === 'password';
  inp.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Hide' : 'Show';
});

// ---------- shell ----------
function menu(open) { $('drawer').classList.toggle('on', open); $('scrim').hidden = !open; $('menuBtn').setAttribute('aria-expanded', open); }
$('menuBtn').addEventListener('click', () => menu(!$('drawer').classList.contains('on')));
$('scrim').addEventListener('click', () => menu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu(false); });
$('bellBtn').addEventListener('click', () => go('vNotif'));
function setBell(n) { $('bellCnt').textContent = n > 99 ? '99+' : n; $('bellCnt').hidden = !n; }
function showLogin() { me = null; clearInterval(pollTimer); menu(false); $('appView').hidden = true; $('loginView').hidden = false; $('lp').value = ''; }
function buildNav() {
  let tabs;
  if (me.must_change) tabs = [['vAccount', 'Choose a password']];
  else if (me.role === 'pr') tabs = [['vFind', 'Find a hall'], ['vMine', 'My bookings'], ['vMsg', 'Message admin'], ['vNotif', 'Notifications'], ['vAccount', 'Account']];
  else {
    tabs = [['vDash', 'Dashboard'], ['vFind', 'Find a hall']];
    if (me.role === 'super' || me.role === 'main') tabs.push(['vManage', 'Manage']);
    tabs.push(['vAudit', 'Audit log'], ['vNotif', 'Notifications'], ['vAccount', 'Account']);
  }
  $('nav').innerHTML = tabs.map(([id, t]) => `<button data-v="${id}" class="${id === view ? 'on' : ''}">${t}</button>`).join('');
  return tabs[0][0];
}
function showApp() {
  $('loginView').hidden = true; $('appView').hidden = false;
  $('avatar').textContent = me.name.trim().charAt(0).toUpperCase();
  $('whoName').textContent = me.name; $('whoProg').textContent = ROLE[me.role] + (me.programme ? ' · ' + me.programme : '');
  $('filters').hidden = innerWidth < 900; $('bellBtn').hidden = !!me.must_change;
  view = me.must_change ? 'vAccount' : (me.role === 'pr' ? 'vFind' : 'vDash');
  buildNav(); go(view);
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {                       // notifications show up without a reload
    if (document.hidden || !me) return;
    try { const m = await api('/api/me'); setBell(m.unread); if (view === 'vNotif') loadNotif(); } catch (e) {}
  }, 20000);
}
function go(v) {
  if (me.must_change) v = 'vAccount';
  view = v; menu(false);
  ['vDash', 'vFind', 'vMine', 'vMsg', 'vManage', 'vAudit', 'vNotif', 'vAccount'].forEach((id) => ($(id).hidden = id !== v));
  $('forceBanner').hidden = !me.must_change;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  scrollTo(0, 0);
  ({ vFind: load, vMine: loadMine, vMsg: loadMsgs, vDash: loadDash, vManage: loadManage, vAudit: loadAudit, vNotif: loadNotif }[v] || (() => {}))();
  if (!me.must_change) api('/api/me').then((m) => setBell(m.unread)).catch(() => {});
}
$('nav').addEventListener('click', (e) => { if (e.target.dataset.v) go(e.target.dataset.v); });

// ---------- login (with the 258-second lock countdown) ----------
function lockCountdown(secs) {
  clearInterval(lockTimer); $('loginBtn').disabled = true; let left = secs;
  const tick = () => { if (left <= 0) { clearInterval(lockTimer); $('loginBtn').disabled = false; say('loginMsg', ''); return; }
    say('loginMsg', `Account locked. Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`); left--; };
  tick(); lockTimer = setInterval(tick, 1000);
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); say('loginMsg', '');
  try { me = await api('/api/login', 'POST', { username: $('lu').value.trim(), password: $('lp').value }); showApp(); }
  catch (err) { if (err.retry) lockCountdown(err.retry); else say('loginMsg', err.message); }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', 'POST', {}); } catch (e) {} showLogin(); });

// ---------- find a hall ----------
function setNow() { const n = new Date(); $('date').value = localDate(n); $('time').value = hhmm(n.getHours() * 60 + n.getMinutes()); load(); }
async function load() {
  if (!$('date').value) return setNow();
  try { data = await api('/api/day?date=' + $('date').value); render(); } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function itemsOf(h) {
  return [
    ...data.classes.filter((c) => c.hall_id === h.id && !c.released).map((c) => ({ s: c.start_min, e: c.end_min, tag: c.course })),
    ...data.moved.filter((c) => c.hall_id === h.id).map((c) => ({ s: c.start_min, e: c.end_min, tag: c.course + ' (moved)' })),
    ...data.bookings.filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, tag: 'Booked: ' + b.by_name })),
  ].sort((a, b) => a.s - b.s);
}
function status(h, m) {
  const it = itemsOf(h), now = it.find((x) => x.s <= m && m < x.e);
  if (now) return { free: false, until: now.e, tag: now.tag, it };
  const nx = it.find((x) => x.s > m);
  return { free: true, until: nx ? nx.s : null, it };
}
const timeline = (it, m) => `<div class="tl" aria-hidden="true">${it.map((i) => { const a = Math.max(i.s, 360), b = Math.min(i.e, 1200); return b > a ? `<i style="left:${(a - 360) / 8.4}%;width:${(b - a) / 8.4}%"></i>` : ''; }).join('')}<u style="left:${Math.min(99.5, Math.max(0, (m - 360) / 8.4))}%"></u></div><div class="tlab"><span>06:00</span><span>13:00</span><span>20:00</span></div>`;
function render() {
  const m = toM($('time').value), grp = $('group').value, minSeats = +$('seats').value || 0, dur = +$('dur').value;
  const q = $('q').value.toLowerCase().replace(/\s+/g, '');
  let rows = data.halls.filter((h) => (!grp || h.grp === grp) && h.seats >= minSeats && (!q || h.name.toLowerCase().replace(/\s+/g, '').includes(q))).map((h) => ({ h, s: status(h, m) }));
  rows = rows.filter((x) => !x.s.free || !dur || x.s.until === null || x.s.until - m >= dur);
  const nFree = rows.filter((x) => x.s.free).length;
  $('stats').innerHTML = `<div class="stat gold"><b>${nFree}</b><span>Free</span></div><div class="stat"><b>${rows.length - nFree}</b><span>In use</span></div><div class="stat"><b>${rows.length}</b><span>Halls</span></div>`;
  const names = Object.fromEntries(data.halls.map((h) => [h.id, h.name]));
  const ch = [
    ...data.classes.filter((c) => c.released).map((c) => ({ s: c.start_min, e: c.end_min, hall: names[c.hall_id], course: c.course, prog: c.programme, chip: KIND[c.kind] + (c.kind === 'postponed' ? ' to ' + fmtDate(c.new_date) + ' ' + hhmm(c.new_start) : '') })),
    ...data.moved.map((c) => ({ s: c.start_min, e: c.end_min, hall: names[c.hall_id], course: c.course, prog: c.programme, chip: 'Moved here from ' + fmtDate(c.from_date) })),
  ].sort((a, b) => a.s - b.s);
  $('changes').innerHTML = ch.length ? `<div class="panel changes"><h2>Changes on ${fmtDate($('date').value)} (${ch.length})</h2><div class="list">${ch.map((x) => `<div class="ln"><span><span class="t">${hhmm(x.s)}–${hhmm(x.e)}</span><b>${esc(x.hall)}</b> · ${esc(x.course)} <small>${esc(x.prog)}</small></span><span class="chip">${esc(x.chip)}</span></div>`).join('')}</div></div>` : '';
  const shown = rows.filter((x) => (tab === 'all' ? true : tab === 'free' ? x.s.free : !x.s.free)).sort((a, b) => b.s.free - a.s.free || (b.s.until ?? 1e9) - (a.s.until ?? 1e9));
  $('list').innerHTML = shown.length ? shown.map(({ h, s }) => `
    <article class="hall ${openHall === h.id ? 'open' : ''}" data-id="${h.id}" tabindex="0" role="button" aria-expanded="${openHall === h.id}">
      <div class="row"><div><h3>${esc(h.name)}</h3><p>${h.seats ? h.seats + ' seats' : 'Seats not set'}</p></div>
      <span class="badge ${s.free ? 'free' : 'taken'}">${s.free ? (s.until ? 'Available until ' + hhmm(s.until) : 'Available all day') : esc(s.tag) + ' · ' + hhmm(s.until)}</span></div>
      ${timeline(s.it, m)}${openHall === h.id ? detail(h, s, m) : ''}
    </article>`).join('') : '<div class="empty">No halls match. Try another time, switch tabs, or loosen the filters.</div>';
}
function detail(h, s, m) {
  const date = $('date').value, future = date >= localDate();
  const can = (c) => me.role === 'super' || me.role === 'main' || (me.role === 'pr' && me.programme && c.programme.trim().toLowerCase() === me.programme.trim().toLowerCase());
  const lines = [
    ...data.classes.filter((c) => c.hall_id === h.id).map((c) => {
      let html, btn = '', form = '';
      if (c.released) {
        html = `<s>${esc(c.course)}</s> <span class="chip">${KIND[c.kind]}${c.kind === 'postponed' ? ' to ' + fmtDate(c.new_date) + ' ' + hhmm(c.new_start) + '–' + hhmm(c.new_end) : ''}</span>`;
        if (future && can(c)) btn = `<button class="mini" data-act="restore" data-id="${c.id}">Undo</button>`;
      } else {
        html = esc(c.course) + (c.programme ? ` <small>${esc(c.programme)}</small>` : '');
        if (future && can(c) && postId !== c.id) btn = `<span class="acts"><button class="mini" data-act="release" data-kind="online" data-id="${c.id}">Online</button><button class="mini" data-act="release" data-kind="cancelled" data-id="${c.id}">Cancel</button><button class="mini" data-act="postpone" data-id="${c.id}">Postpone</button></span>`;
        if (postId === c.id) form = `<div class="pf" style="width:100%"><input type="date" id="pDate" min="${localDate()}" value="${date}"><input type="time" id="pStart" value="${hhmm(c.start_min)}"><input type="time" id="pEnd" value="${hhmm(c.end_min)}"><button class="btn" data-act="confirmPost" data-id="${c.id}">Confirm</button><button class="btn ghost" data-act="backPost">Back</button></div>`;
      }
      return { s: c.start_min, e: c.end_min, html, btn, form };
    }),
    ...data.moved.filter((c) => c.hall_id === h.id).map((c) => ({ s: c.start_min, e: c.end_min, html: `${esc(c.course)} <span class="chip">Moved here from ${fmtDate(c.from_date)}</span>`, btn: '', form: '' })),
    ...data.bookings.filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, html: `Booked by ${esc(b.by_name)} · ${esc(b.purpose)} <span class="chip">Approved</span>`, btn: '', form: '' })),
    ...data.pending.filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, html: `${esc(b.by_name)} · ${esc(b.purpose)} <span class="chip line">${b.status === 'alternative' ? 'Alternative offered' : 'Pending, not yet approved'}</span>`, btn: '', form: '' })),
  ].sort((a, b) => a.s - b.s);
  const from = s.free ? m : s.until, to = s.free ? Math.min(m + 60, s.until ?? m + 60) : s.until + 60;
  const form = me.role === 'pr' ? `<div class="bk">
      <input class="wide" id="bkPurpose" placeholder="Request this hall: purpose (e.g. CSC 205 group study)" maxlength="80" style="grid-column:1/-1">
      <input type="time" id="bkFrom" value="${hhmm(Math.min(from, 1439))}"><input type="time" id="bkTo" value="${hhmm(Math.min(to, 1439))}">
      <button class="btn" data-act="book" data-id="${h.id}">Send request</button>
      <p class="msg wide" id="bkMsg" style="grid-column:1/-1"></p></div>` : '';
  return `<div class="detail">${lines.length ? lines.map((l) => `<div class="ln"><span><span class="t">${hhmm(l.s)}–${hhmm(l.e)}</span>${l.html}</span>${l.btn}${l.form}</div>`).join('') : '<p class="muted">No classes or bookings on this date.</p>'}${form}</div>`;
}
$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { act, id, kind } = btn.dataset, date = $('date').value;
    try {
      if (act === 'postpone') { postId = +id; return render(); }
      if (act === 'backPost') { postId = null; return render(); }
      if (act === 'release') await api('/api/releases', 'POST', { class_id: +id, date, kind });
      else if (act === 'confirmPost') { await api('/api/releases', 'POST', { class_id: +id, date, kind: 'postponed', new_date: $('pDate').value, new_start: $('pStart').value, new_end: $('pEnd').value }); postId = null; }
      else if (act === 'restore') await api('/api/releases', 'DELETE', { class_id: +id, date });
      else if (act === 'book') {
        await api('/api/bookings', 'POST', { hall_id: +id, date, start: $('bkFrom').value, end: $('bkTo').value, purpose: $('bkPurpose').value });
        await load(); say('bkMsg', 'Request sent. It stays pending until an administrator decides.', true); return;
      }
      await load();
    } catch (err) { if ($('bkMsg')) say('bkMsg', err.message); else alert(err.message); }
    return;
  }
  if (e.target.closest('.detail')) return;
  const el = e.target.closest('.hall'); if (!el) return;
  openHall = openHall === +el.dataset.id ? null : +el.dataset.id; postId = null; render();
});
$('list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('hall')) { e.preventDefault(); e.target.click(); } });
['date', 'time'].forEach((id) => $(id).addEventListener('change', load));
['group', 'seats', 'dur', 'q'].forEach((id) => $(id).addEventListener('input', render));
$('now').addEventListener('click', setNow);
$('filterBtn').addEventListener('click', () => { $('filters').hidden = !$('filters').hidden; $('filterBtn').setAttribute('aria-expanded', !$('filters').hidden); });
[['tFree', 'free'], ['tBusy', 'busy'], ['tAll', 'all']].forEach(([id, v]) => $(id).addEventListener('click', () => { tab = v; ['tFree', 'tBusy', 'tAll'].forEach((x) => $(x).classList.toggle('on', x === id)); render(); }));

// ---------- representative: my booking requests ----------
const STATUS = { pending: ['Pending', 'line'], approved: ['Approved', ''], rejected: ['Rejected', 'muted'], cancelled: ['Cancelled', 'muted'], alternative: ['Alternative offered', 'warn'] };
const slot = (b) => `<b>${fmtDate(b.date)}</b> · ${hhmm(b.start_min)}–${hhmm(b.end_min)} · ${esc(b.hall)}`;
async function loadMine() {
  try {
    const rows = await api('/api/bookings');
    $('mine').innerHTML = rows.length ? rows.map((b) => `<div class="item"><div class="l1">${slot(b)}</div><div class="l2">${esc(b.purpose)}</div>
      <div class="l3"><span class="chip ${STATUS[b.status][1]}">${STATUS[b.status][0]}</span>${b.cancel_req ? '<span class="chip warn">Cancellation requested</span>' : ''}</div>
      ${b.decision_reason && ['rejected', 'approved', 'alternative', 'cancelled'].includes(b.status) ? `<div class="reply">Admin: ${esc(b.decision_reason)}</div>` : ''}
      ${b.status === 'alternative' ? `<div class="reply">Proposed instead: <b>${fmtDate(b.alt_date)} · ${hhmm(b.alt_start)}–${hhmm(b.alt_end)} · ${esc(b.alt_hall_name)}</b></div>` : ''}
      <div class="acts">${b.status === 'alternative' ? `<button class="mini" data-resp="1" data-id="${b.id}">Accept alternative</button><button class="mini" data-resp="0" data-id="${b.id}">Decline</button>` : ''}
      ${b.status === 'pending' ? `<button class="mini" data-cancel="${b.id}">Withdraw request</button>` : ''}
      ${b.status === 'approved' && !b.cancel_req ? `<button class="mini" data-cancel="${b.id}">Ask to cancel</button>` : ''}</div></div>`).join('')
      : '<div class="empty">No booking requests yet. Open a hall in Find a hall and tap Send request.</div>';
  } catch (e) { $('mine').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('mine').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.resp !== undefined) await api(`/api/bookings/${d.id}/respond`, 'POST', { accept: d.resp === '1' });
    else if (d.cancel) { const r = ask('Reason (needed for approved bookings):'); if (r === null) return; await api(`/api/bookings/${d.cancel}/cancel`, 'POST', { reason: r }); }
    else return;
    loadMine();
  } catch (err) { alert(err.message); }
});

// ---------- staff dashboard ----------
async function loadDash() {
  try {
    const [ov, bk] = await Promise.all([api('/api/admin/overview'), has('bookings.view') || has('bookings.decide') ? api('/api/bookings').catch(() => []) : []]);
    const pend = bk.filter((b) => b.status === 'pending' || b.status === 'alternative'), appr = bk.filter((b) => b.status === 'approved');
    $('dPend').textContent = pend.length; $('dBook').textContent = appr.length; $('dChg').textContent = ov.changes.length;
    const age = (ms) => { const h = Math.floor((Date.now() - ms) / 3600000); return h >= 24 ? `waiting ${Math.floor(h / 24)}d` : h >= 1 ? `waiting ${h}h` : 'new'; };
    $('dPendList').innerHTML = pend.length ? pend.map((b) => `<div class="item"><div class="l1">${slot(b)}</div><div class="l2">${esc(b.purpose)} <small>${esc(b.by_name)} · ${esc(b.programme)}</small></div>
      <div class="l3"><span class="chip ${Date.now() - b.created > 86400000 ? 'warn' : 'line'}">${b.status === 'alternative' ? 'Alternative offered' : 'Pending'} · ${age(b.created)}</span></div>
      ${b.status === 'pending' && has('bookings.decide') ? `<div class="acts"><button class="mini" data-dec="approve" data-id="${b.id}">Approve</button><button class="mini" data-dec="reject" data-id="${b.id}">Reject</button><button class="mini" data-dec="alternative" data-id="${b.id}" data-hall="${esc(b.hall)}" data-date="${b.date}" data-s="${hhmm(b.start_min)}" data-e="${hhmm(b.end_min)}">Suggest alternative</button></div>` : ''}</div>`).join('')
      : `<p class="muted">${has('bookings.view') ? 'No requests waiting.' : 'You have not been given access to booking requests.'}</p>`;
    $('dBookList').innerHTML = appr.length ? appr.map((b) => `<div class="item"><div class="l1">${slot(b)}</div><div class="l2">${esc(b.purpose)} <small>${esc(b.by_name)}</small></div>
      <div class="l3">${b.cancel_req ? `<span class="chip warn">Cancellation requested: ${esc(b.cancel_req)}</span>` : ''}${has('bookings.cancel') ? `<button class="mini" data-cancel="${b.id}">${b.cancel_req ? 'Confirm cancellation' : 'Cancel booking'}</button>` : ''}</div></div>`).join('')
      : '<p class="muted">No approved bookings.</p>';
    $('dChgList').innerHTML = ov.changes.length ? ov.changes.map((c) => `<div class="item"><div class="l1"><b>${fmtDate(c.date)}</b> · ${hhmm(c.start_min)}–${hhmm(c.end_min)} · ${esc(c.hall)}</div><div class="l2">${esc(c.course)} <small>${esc(c.programme)}</small></div>
      <div class="l3"><span class="chip">${KIND[c.kind]}${c.kind === 'postponed' ? ' to ' + fmtDate(c.new_date) + ' ' + hhmm(c.new_start) + '–' + hhmm(c.new_end) : ''}</span><small>by ${esc(c.by_name || 'unknown')}${c.created ? ' · ' + when(c.created) : ''}</small></div></div>`).join('') : '<p class="muted">No class changes yet.</p>';
    $('dMsgPanel').hidden = !has('messages.handle');
    if (has('messages.handle')) {
      const ms = await api('/api/messages');
      $('dUnread').hidden = !ov.unread; $('dUnread').textContent = ov.unread;
      $('dMsgList').innerHTML = ms.length ? ms.map((m) => `<div class="item ${m.is_read ? '' : 'unread'}"><div class="l1"><b>${esc(m.name)}</b> <small>${esc(m.programme)} · ${when(m.created)}</small></div><div class="l2">${esc(m.body)}</div>${m.reply ? `<div class="reply">Reply: ${esc(m.reply)}</div>` : ''}
        <div class="acts"><button class="mini" data-reply="${m.id}">Reply</button>${m.is_read ? '' : `<button class="mini" data-read="${m.id}">Mark read</button>`}</div></div>`).join('') : '<p class="muted">No messages.</p>';
    }
  } catch (e) { $('dPendList').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
$('vDash').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.dec) {
      const reason = ask({ approve: 'Reason for approving:', reject: 'Reason for rejecting:', alternative: 'Reason for suggesting another slot:' }[d.dec], d.dec === 'approve' ? 'Hall is free' : '');
      if (!reason) return;
      const body = { decision: d.dec, reason };
      if (d.dec === 'alternative') {
        const hall = ask('Alternative hall (e.g. NLT 5):', d.hall); if (!hall) return;
        const date = ask('Date (YYYY-MM-DD):', d.date); if (!date) return;
        const start = ask('Start (HH:MM):', d.s); if (!start) return;
        const end = ask('End (HH:MM):', d.e); if (!end) return;
        body.alt = { hall, date, start, end };
      }
      await api(`/api/bookings/${d.id}/decision`, 'POST', body);
    } else if (d.cancel) { const r = ask('Reason for cancelling (required):'); if (!r) return; await api(`/api/bookings/${d.cancel}/cancel`, 'POST', { reason: r }); }
    else if (d.read) await api(`/api/messages/${d.read}/read`, 'POST');
    else if (d.reply) { const t = ask('Your reply:'); if (!t) return; await api(`/api/messages/${d.reply}/reply`, 'POST', { text: t }); }
    else return;
    loadDash();
  } catch (err) { alert(err.message); }
});

// ---------- representative: messages ----------
async function loadMsgs() {
  try {
    const ms = await api('/api/messages');
    $('msgList').innerHTML = ms.length ? ms.map((m) => `<div class="item"><div class="l1"><small>${when(m.created)}</small></div><div class="l2">${esc(m.body)}</div>${m.reply ? `<div class="reply"><b>Admin:</b> ${esc(m.reply)}</div>` : '<small>Waiting for a reply</small>'}</div>`).join('') : '<div class="empty">No messages yet.</div>';
  } catch (e) { $('msgList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/messages', 'POST', { body: $('msgBody').value }); $('msgForm').reset(); say('msgMsg', 'Sent to the Main Admin.', true); loadMsgs(); } catch (err) { say('msgMsg', err.message); }
});

// ---------- manage accounts, timetable, seats ----------
const PERMS = { 'bookings.view': 'See booking requests', 'bookings.decide': 'Approve / reject requests', 'bookings.cancel': 'Cancel bookings', 'halls.manage': 'Manage halls', 'messages.handle': 'Handle rep messages' };
async function loadManage() {
  $('ur').innerHTML = (me.role === 'super' ? [['pr', 'Programme Rep'], ['delegated', 'Delegated Admin'], ['main', 'Main Admin']] : [['delegated', 'Delegated Admin']]).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('upWrap').hidden = $('ur').value !== 'pr';
  $('ttPanel').hidden = me.role !== 'super'; $('seatPanel').hidden = !has('halls.manage'); $('permEditor').hidden = true;
  try {
    const users = await api('/api/users');
    $('users').innerHTML = users.map((u) => {
      const lower = RANK[me.role] > RANK[u.role], archived = u.status === 'archived', locked = u.locked_until > Date.now();
      return `<div class="item"><div class="l1"><b>${esc(u.name)}</b> <small>@${esc(u.username)}</small></div>
        <div class="l2"><span class="chip muted">${ROLE[u.role]}</span> ${u.programme ? `<small>${esc(u.programme)}</small>` : ''} ${u.status !== 'active' ? `<span class="chip warn">${u.status}</span> <small>${esc(u.status_reason || '')}</small>` : ''}${locked ? ' <span class="chip warn">locked</span>' : ''}
        ${u.role === 'delegated' && !archived ? `<br><small>${u.perms.length ? u.perms.map((p) => PERMS[p]).join(' · ') : 'No permissions yet'}</small>` : ''}</div>
        ${lower && !archived ? `<div class="acts"><button class="mini" data-u="reset" data-id="${u.id}">Reset password</button>
          ${u.status === 'active' ? `<button class="mini" data-u="suspended" data-id="${u.id}">Suspend</button>${me.role === 'super' ? `<button class="mini" data-u="frozen" data-id="${u.id}">Freeze</button>` : ''}` : `<button class="mini" data-u="active" data-id="${u.id}">Reinstate</button>`}
          ${locked ? `<button class="mini" data-u="unlock" data-id="${u.id}">Unlock</button>` : ''}
          ${u.role === 'delegated' ? `<button class="mini" data-u="perms" data-id="${u.id}" data-p="${u.perms.join(',')}">Permissions</button>` : ''}
          <button class="mini" data-u="deactivate" data-id="${u.id}">Deactivate</button></div>` : ''}</div>`;
    }).join('');
    if (me.role === 'super') $('ttCount').textContent = `${(await api('/api/timetable/count')).n} timetable entries loaded.`;
    if (has('halls.manage')) $('halls').innerHTML = (await api('/api/day?date=' + localDate())).halls.map((h) => `<label>${esc(h.name)}<input type="number" min="0" value="${h.seats}" data-hall="${h.id}"></label>`).join('');
  } catch (e) { say('userMsg', e.message); }
}
$('ur').addEventListener('change', () => ($('upWrap').hidden = $('ur').value !== 'pr'));
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/users', 'POST', { name: $('un').value, username: $('uu').value, role: $('ur').value, programme: $('up').value, password: $('upw').value });
    $('userForm').reset(); say('userMsg', 'Account created. Give the username and temporary password to the person privately.', true); loadManage();
  } catch (err) { say('userMsg', err.message); }
});
$('users').addEventListener('click', async (e) => {
  const d = e.target.dataset; if (!d.u) return;
  try {
    if (d.u === 'perms') {
      const cur = (d.p || '').split(',');
      $('permEditor').hidden = false;
      $('permEditor').innerHTML = `<h2>Permissions</h2><div class="checks">${Object.entries(PERMS).map(([k, t]) => `<label><input type="checkbox" value="${k}" ${cur.includes(k) ? 'checked' : ''}> ${t}</label>`).join('')}</div>
        <label>Expires on (optional) <input type="date" id="peExp" min="${localDate()}"></label><label>Reason <input id="peWhy" placeholder="Why this access?"></label>
        <div class="acts"><button class="btn" id="peSave" data-id="${d.id}">Save permissions</button><button class="btn ghost" id="peClose">Close</button></div><p class="msg" id="peMsg"></p>`;
      $('permEditor').scrollIntoView({ behavior: 'smooth' }); return;
    }
    if (d.u === 'reset') { const why = ask('How did you verify this person? (required)'); if (!why) return; const pw = ask('Temporary password (6+ characters):'); if (!pw) return; await api(`/api/users/${d.id}/reset`, 'POST', { password: pw, reason: why }); alert('Done. They must choose a new password at next sign-in.'); }
    else if (d.u === 'unlock') { const why = ask('How did you verify this person? (required)'); if (!why) return; await api(`/api/users/${d.id}/unlock`, 'POST', { reason: why }); }
    else if (d.u === 'deactivate') { const why = ask('Reason for deactivating (history is kept):'); if (!why) return; await api(`/api/users/${d.id}/deactivate`, 'POST', { reason: why }); }
    else { const why = ask(`Reason for ${d.u === 'active' ? 'reinstating' : d.u}:`); if (!why) return; await api(`/api/users/${d.id}/status`, 'POST', { status: d.u, reason: why }); }
    loadManage();
  } catch (err) { alert(err.message); }
});
$('permEditor').addEventListener('click', async (e) => {
  if (e.target.id === 'peClose') $('permEditor').hidden = true;
  if (e.target.id === 'peSave') {
    try {
      await api(`/api/users/${e.target.dataset.id}/permissions`, 'POST', { perms: [...$('permEditor').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value), expires: $('peExp').value || null, reason: $('peWhy').value });
      $('permEditor').hidden = true; loadManage();
    } catch (err) { say('peMsg', err.message); }
  }
});
$('halls').addEventListener('change', async (e) => { if (e.target.dataset.hall) try { await api('/api/halls/' + e.target.dataset.hall, 'PATCH', { seats: +e.target.value }); } catch (err) { alert(err.message); } });
$('ttGo').addEventListener('click', async () => {
  const files = [...$('ttFile').files]; if (!files.length) return say('ttMsg', 'Choose one or more CSV files first.');
  if ($('ttReplace').checked && !confirm('This replaces the whole official timetable. Continue?')) return;
  try {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, csv: await f.text() })));
    const r = await api('/api/timetable/import', 'POST', { files: payload, replace: $('ttReplace').checked });
    say('ttMsg', `${r.imported} classes published from ${r.files} file(s).` + (r.skipped ? ` ${r.skipped} duplicate rows skipped.` : ''), true); $('ttFile').value = ''; loadManage();
  } catch (err) { say('ttMsg', err.message + (err.details ? ' ' + err.details.join(' ') : '')); }
});

// ---------- audit log ----------
async function loadAudit() {
  const p = new URLSearchParams(); [['module', 'aMod'], ['severity', 'aSev'], ['actor', 'aWho'], ['action', 'aAct'], ['from', 'aFrom']].forEach(([k, id]) => $(id).value && p.set(k, $(id).value));
  try {
    const rows = await api('/api/audit?' + p);
    $('auditList').innerHTML = rows.length ? rows.map((r) => `<div class="item"><div class="l1"><b>${esc(r.action.replace(/_/g, ' '))}</b> · ${esc(r.module)} <span class="chip ${r.severity === 'info' ? 'muted' : 'warn'}">${r.severity}</span></div>
      <div class="l2">${esc(r.target)} <small>by ${esc(r.actor_name)} (${ROLE[r.actor_role] || r.actor_role}) · ${when(r.created)}</small></div>${r.reason ? `<div class="reply">${esc(r.reason)}</div>` : ''}
      ${r.before || r.after ? `<details><summary>Before / after</summary><pre>${esc((r.before || '') + (r.before && r.after ? '\n→ ' : '') + (r.after || ''))}</pre></details>` : ''}</div>`).join('') : '<div class="empty">Nothing matches.</div>';
  } catch (e) { $('auditList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('aGo').addEventListener('click', loadAudit);

// ---------- notifications ----------
const LINKS = { dash: 'vDash', mine: 'vMine', msg: 'vMsg', audit: 'vAudit' };
async function loadNotif() {
  try {
    const [list, prefs] = await Promise.all([api('/api/notifications'), api('/api/notif-prefs')]);
    $('prefs').innerHTML = prefs.map((p) => `<label class="inline"><input type="checkbox" data-cat="${p.category}" ${p.enabled ? 'checked' : ''}> ${p.category[0].toUpperCase() + p.category.slice(1)}</label>`).join('');
    $('notifList').innerHTML = list.length ? list.map((n) => `<div class="item ${n.is_read ? '' : 'unread'}" data-n="${n.id}" data-link="${n.link}"><div class="l1"><b>${esc(n.title)}</b> <small>${esc(n.category)} · ${when(n.created)}</small></div><div class="l2">${esc(n.body)}</div></div>`).join('') : '<div class="empty">Nothing yet.</div>';
    setBell(list.filter((n) => !n.is_read).length);
  } catch (e) { $('notifList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('prefs').addEventListener('change', async (e) => { if (e.target.dataset.cat) try { await api('/api/notif-prefs', 'PUT', { category: e.target.dataset.cat, enabled: e.target.checked }); } catch (err) { alert(err.message); } });
$('readAll').addEventListener('click', async () => { await api('/api/notifications/read', 'POST', {}); loadNotif(); });
$('notifList').addEventListener('click', async (e) => {
  const el = e.target.closest('.item'); if (!el) return;
  await api('/api/notifications/read', 'POST', { id: +el.dataset.n }).catch(() => {});
  const target = LINKS[el.dataset.link]; if (target && document.querySelector(`#nav [data-v=${target}]`)) go(target); else loadNotif();
});

// ---------- account: password with strength meter ----------
function strength(p) {
  if (!p) return { s: 0, label: '', tip: 'Pick anything you will remember. A longer password is stronger.' };
  let s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/\d/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p)) s++;
  const common = ['password', '123456', 'qwerty', 'admin', 'letmein', 'welcome', 'ucc', 'abc123', 'iloveyou', '111111'], isCommon = common.some((c) => p.toLowerCase().includes(c));
  if (isCommon) s = Math.min(s, 1);
  const label = s <= 1 ? 'Weak' : s === 2 ? 'Fair' : s === 3 ? 'Strong' : 'Very strong';
  const tip = isCommon ? 'This looks easy to guess. Avoid common words and numbers.' : p.length < 8 ? 'Try 8 or more characters.' : s < 4 ? 'Mix capitals, numbers or a symbol to make it stronger.' : 'Good password.';
  return { s, label, tip };
}
$('pn').addEventListener('input', () => { const r = strength($('pn').value); $('pwBar').style.width = ($('pn').value ? Math.max(12, r.s * 22) : 0) + '%'; $('pwHint').textContent = r.label ? `${r.label}. ${r.tip}` : r.tip; });
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/password', 'POST', { current: $('pc').value, next: $('pn').value }); $('pwForm').reset(); $('pwBar').style.width = '0';
    if (me.must_change) { me.must_change = 0; $('bellBtn').hidden = false; showApp(); } else say('pwMsg', 'Password updated.', true);
  } catch (err) { say('pwMsg', err.message); }
});

// ---------- start ----------
(async () => {
  $('group').innerHTML = '<option value="">All halls</option>' + ['SWLT', 'NLT', 'LT', 'CALC'].map((g) => `<option>${g}</option>`).join('');
  try { me = await api('/api/me'); showApp(); } catch (e) { showLogin(); }
})();
