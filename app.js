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
  if (!res.ok) { const err = new Error(j.error || 'Request failed.'); Object.assign(err, { details: j.details, retry: j.retry_after, impact: j.impact }); throw err; }
  return j;
}
const say = (id, text, ok) => { const el = $(id); if (!el) return; el.textContent = text; el.className = 'msg' + (el.classList.contains('wide') ? ' wide' : '') + (text ? (ok ? ' ok' : ' err') : ''); };
const ask = (q, def) => { const v = prompt(q, def || ''); return v === null ? null : v.trim(); };

// ---------- theme + glass ----------
function applyTheme(t) { document.documentElement.dataset.theme = t; document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#07131f' : '#0c1d32'; }
let savedTheme = null; try { savedTheme = localStorage.getItem('theme'); } catch (e) {}
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeBtn').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(t); try { localStorage.setItem('theme', t); } catch (e) {} });

// show / hide password buttons
document.addEventListener('click', (e) => {
  if (!e.target.dataset.eye) return;
  const inp = e.target.previousElementSibling, show = inp.type === 'password';
  inp.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Hide' : 'Show';
});

// ---------- shell ----------
const IC = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  cal: 'M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  msg: 'M4 5h16v11H9l-5 4z',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  manage: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  audit: 'M9 4h6l1 2h3v14H5V6h3zM9 12h6M9 16h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.5-6 8-6s8 2 8 6',
  key: 'M14 10a4 4 0 1 0-3.9 4L21 14v3h-3v3h-3v-3h-2.5',
  building: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  check: 'M5 13l4 4L19 7',
  swap: 'M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1',
  info: 'M12 11v5M12 8v.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  tt: 'M5 4h14v16H5zM9 4v16M5 10h14M5 15h14',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5'
};
const ic = (n, z = 20) => `<svg width="${z}" height="${z}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const ago = (ms) => { const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
const wideScreen = () => innerWidth >= 901;
const navCounts = {};
function setBadge(v, n) { navCounts[v] = n; const b = document.querySelector(`#nav [data-v=${v}] .nb`); if (b) { b.textContent = n > 99 ? '99+' : n; b.hidden = !n; } }
// phones/tablets: slide-out drawer. Desktop: the sidebar stays, and the menu button collapses it.
function menu(open) { if (wideScreen()) return; $('drawer').classList.toggle('on', open); $('scrim').hidden = !open; $('menuBtn').setAttribute('aria-expanded', open); }
function collapseSide(on) { document.body.classList.toggle('collapsed', on); $('menuBtn').setAttribute('aria-expanded', !on); try { localStorage.setItem('side', on ? 'off' : 'on'); } catch (e) {} }
try { if (localStorage.getItem('side') === 'off') document.body.classList.add('collapsed'); } catch (e) {}
$('menuBtn').addEventListener('click', () => (wideScreen() ? collapseSide(!document.body.classList.contains('collapsed')) : menu(!$('drawer').classList.contains('on'))));
$('scrim').addEventListener('click', () => menu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu(false); });
$('bellBtn').addEventListener('click', () => go('vNotif'));
function setBell(n) { $('bellCnt').textContent = n > 99 ? '99+' : n; $('bellCnt').hidden = !n; setBadge('vNotif', n); }
function showLogin() { me = null; clearInterval(pollTimer); menu(false); $('appView').hidden = true; $('loginView').hidden = false; $('lp').value = ''; }
function buildNav() {
  let tabs;
  if (me.must_change) tabs = [['vAccount', 'Choose a password', 'key']];
  else if (me.role === 'pr') tabs = [['vDash', 'Dashboard', 'home'], ['vFind', 'Search Halls', 'search'], ['vMine', 'My Bookings', 'cal'], ['vTT', 'Timetable', 'tt'], ['vMsg', 'Messages', 'msg'], ['vRep', 'Report a concern', 'flag'], ['vNotif', 'Notifications', 'bell'], ['vAccount', 'Account', 'user']];
  else {
    tabs = [['vDash', 'Dashboard', 'home'], ['vFind', 'Search Halls', 'search']];
    if (me.role === 'super' || me.role === 'main') tabs.push(['vManage', 'Manage', 'manage']);
    if (me.role === 'super') tabs.push(['vTT', 'Timetables', 'tt'], ['vCal', 'Academic Calendar', 'cal'], ['vSec', 'Security', 'shield']);
    tabs.push([ 'vRep', me.role === 'main' ? 'Report / Petition' : 'Report a concern', 'flag'], ['vAudit', 'Audit Log', 'audit'], ['vNotif', 'Notifications', 'bell'], ['vAccount', 'Account', 'user']);
  }
  $('nav').innerHTML = tabs.map(([id, t, i]) => `<button data-v="${id}" class="${id === view ? 'on' : ''}">${ic(i, 22)}<span class="nl">${t}</span><span class="nb" hidden>0</span></button>`).join('');
  Object.entries(navCounts).forEach(([v, n]) => setBadge(v, n));
  return tabs[0][0];
}
function showApp() {
  $('loginView').hidden = true; $('appView').hidden = false;
  const ini = me.name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();
  $('avatar').textContent = ini; $('profAvatar').textContent = ini; $('roleTxt').textContent = ROLE[me.role]; $('profName').textContent = me.name; $('profRole').textContent = ROLE[me.role]; $('profProg').textContent = me.programme || '';
  $('whoName').textContent = me.name; $('whoProg').textContent = ROLE[me.role] + (me.programme ? ' · ' + me.programme : '');
  $('filters').hidden = innerWidth < 900; $('bellBtn').hidden = !!me.must_change;
  view = me.must_change ? 'vAccount' : 'vDash';
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
  ['vDash', 'vFind', 'vMine', 'vMsg', 'vManage', 'vTT', 'vCal', 'vSec', 'vRep', 'vAudit', 'vNotif', 'vAccount'].forEach((id) => ($(id).hidden = id !== v));
  $('forceBanner').hidden = !me.must_change;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  scrollTo(0, 0);
  ({ vFind: load, vMine: loadMine, vMsg: loadMsgs, vDash: loadDash, vManage: loadManage, vTT: loadTT, vCal: loadCal, vSec: loadSec, vRep: loadRep, vAudit: loadAudit, vNotif: loadNotif }[v] || (() => {}))();
  if (!me.must_change) api('/api/me').then((m) => setBell(m.unread)).catch(() => {});
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) go(b.dataset.v); });

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
    ...(data.blocks || []).filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, tag: 'Unavailable: ' + b.reason })),
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
    ...(data.blocks || []).filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: Math.min(b.end_min, 1439), html: `Unavailable: ${esc(b.reason)} <span class="chip warn">Maintenance</span>`, btn: '', form: '' })),
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
  const now = new Date(), today = localDate(now), nm = now.getHours() * 60 + now.getMinutes();
  try {
    const rows = await api('/api/bookings');
    $('mine').innerHTML = rows.length ? rows.map((b) => {
      const live = b.status === 'approved' && b.date === today && b.start_min <= nm && nm < b.end_min;
      return `<div class="item"><div class="l1">${slot(b)}</div><div class="l2">${esc(b.purpose)}</div>
      <div class="l3"><span class="chip ${STATUS[b.status][1]}">${STATUS[b.status][0]}</span>${b.cancel_req ? '<span class="chip warn">Cancellation requested</span>' : ''}${b.ext_end ? `<span class="chip line">Extension to ${hhmm(b.ext_end)} requested</span>` : ''}${b.release_req ? '<span class="chip line">Early release reported</span>' : ''}${b.alt_state === 'accepted' ? '<span class="chip line">Replacement awaiting approval</span>' : ''}</div>
      ${b.decision_reason && ['rejected', 'approved', 'alternative', 'cancelled'].includes(b.status) ? `<div class="reply">Admin: ${esc(b.decision_reason)}</div>` : ''}
      ${b.status === 'alternative' ? `<div class="reply">Proposed instead: <b>${fmtDate(b.alt_date)} · ${hhmm(b.alt_start)}–${hhmm(b.alt_end)} · ${esc(b.alt_hall_name)}</b></div>` : ''}
      ${b.alt_state === 'offered' ? `<div class="reply"><b>Your hall is unavailable</b> (${esc(b.maint_note)}). Your booking is kept. Suggested replacement: <b>${esc(b.alt_hall_name)}</b>.</div>` : ''}
      <div class="acts">${b.status === 'alternative' ? `<button class="mini" data-resp="1" data-id="${b.id}">Accept alternative</button><button class="mini" data-resp="0" data-id="${b.id}">Decline</button>` : ''}
      ${b.alt_state === 'offered' ? `<button class="mini" data-mresp="1" data-id="${b.id}">Accept replacement</button><button class="mini" data-mresp="0" data-id="${b.id}">Decline</button>` : ''}
      ${b.status === 'pending' ? `<button class="mini" data-cancel="${b.id}">Withdraw request</button>` : ''}
      ${b.status === 'approved' && !b.cancel_req ? `<button class="mini" data-cancel="${b.id}">Ask to cancel</button>` : ''}
      ${b.status === 'approved' && !b.ext_end ? `<button class="mini" data-ext="${b.id}">Ask for more time</button>` : ''}
      ${live && !b.release_req ? `<button class="mini" data-vac="${b.id}">We have left (release early)</button>` : ''}</div></div>`;
    }).join('') : '<div class="empty">No booking requests yet. Open a hall in Search Halls and tap Send request.</div>';
  } catch (e) { $('mine').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('mine').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.resp !== undefined) await api(`/api/bookings/${d.id}/respond`, 'POST', { accept: d.resp === '1' });
    else if (d.mresp !== undefined) await api(`/api/bookings/${d.id}/maint-response`, 'POST', { accept: d.mresp === '1' });
    else if (d.cancel) { const r = ask('Reason (needed for approved bookings):'); if (r === null) return; await api(`/api/bookings/${d.cancel}/cancel`, 'POST', { reason: r }); }
    else if (d.ext) { const t = ask('New end time (HH:MM):'); if (!t) return; const r = ask('Why do you need more time?'); if (!r) return; const x = await api(`/api/bookings/${d.ext}/extend`, 'POST', { new_end: t, reason: r }); if (x.conflict) alert('Sent, but note: ' + x.conflict + ' The timetable and other bookings come first.'); }
    else if (d.vac) { if (!confirm('Tell the admin this hall is now empty so it can be released?')) return; await api(`/api/bookings/${d.vac}/vacated`, 'POST', {}); }
    else return;
    loadMine();
  } catch (err) { alert(err.message); }
});

// ---------- dashboard (staff and representatives) ----------
const pill = (b) => ({
  pending: `<span class="pill pend">${ic('clock', 14)}Pending</span>`,
  approved: `<span class="pill ok">${ic('check', 14)}Approved</span>`,
  alternative: '<span class="pill warn">Alternative offered</span>',
  rejected: '<span class="pill off">Rejected</span>',
  cancelled: '<span class="pill off">Cancelled</span>'
}[b.status] || '');
const brow = (b, sub, actions) => `<div class="brow"><div class="bthumb">${ic('building', 28)}</div>
  <div class="bmain"><b>${esc(b.hall)}</b><div class="bmeta"><span>${ic('cal', 14)}${fmtDate(b.date)}</span><span>${ic('clock', 14)}${hhmm(b.start_min)} – ${hhmm(b.end_min)}</span></div><div class="bsub">${sub}</div></div>
  <div class="bside">${pill(b)}${actions ? `<div class="acts">${actions}</div>` : ''}</div></div>`;
const crow = (c) => `<div class="crow"><span class="cico">${ic('swap', 18)}</span><div><b>${esc(c.course)}</b><div class="bmeta"><span>${c.date ? fmtDate(c.date) + ' · ' : ''}${hhmm(c.s)} – ${hhmm(c.e)} · ${esc(c.hall || '')}</span></div><small>${esc(c.prog || '')}${c.by ? ' · by ' + esc(c.by) : ''}</small></div><span class="pill ok">${esc(c.chip)}</span></div>`;
const changeChip = (c) => KIND[c.kind] + (c.kind === 'postponed' ? ' to ' + fmtDate(c.new_date) + ' ' + hhmm(c.new_start) : '');
const infoBox = (t) => `<div class="infobox">${ic('info', 20)}<span>${t}</span></div>`;

function setHero() {
  const h = new Date().getHours(), part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  $('heroTitle').textContent = `Good ${part}, ${me.name}! 👋`;
  $('heroSub').textContent = me.role === 'pr' ? 'Find and book the perfect lecture hall for your programme.' : 'Here is what needs your attention today.';
}
function prepQuick() {
  const n = new Date();
  if (!$('dqDate').value) $('dqDate').value = localDate(n);
  if (!$('dqTime').value) $('dqTime').value = hhmm(n.getHours() * 60 + n.getMinutes());
  $('dqGroup').innerHTML = $('group').innerHTML;
}
function renderActivity(list) {
  $('dActList').innerHTML = list.length ? list.slice(0, 4).map((n) => `<div class="act" data-link="${esc(n.link)}"><i class="${/approv/i.test(n.title) ? 'g' : n.is_read ? 'r' : ''}"></i><div><b>${esc(n.title)}</b><span>${esc(n.body)}</span></div><small>${ago(n.created)}</small></div>`).join('') : infoBox('Nothing yet. Updates will appear here.');
}
async function loadDash() {
  const rep = me.role === 'pr';
  setHero(); prepQuick();
  ['dBookPanel', 'dMsgPanel', 'dMaintPanel'].forEach((id) => ($(id).hidden = rep));
  $('dViewAll').hidden = !rep;
  $('dChgTitle').textContent = rep ? 'Class changes (today)' : 'Class changes (today onwards)';
  try { rep ? await loadRepDash() : await loadStaffDash(); }
  catch (e) { $('dPendList').innerHTML = infoBox(esc(e.message)); }
}
async function loadRepDash() {
  const today = localDate();
  const [bk, notes, day] = await Promise.all([api('/api/bookings'), api('/api/notifications').catch(() => []), api('/api/day?date=' + today).catch(() => null)]);
  const open = bk.filter((b) => ['pending', 'alternative', 'approved'].includes(b.status));
  const pend = open.filter((b) => b.status !== 'approved'), appr = open.filter((b) => b.status === 'approved');
  const mineProg = (p) => !me.programme || (p || '').trim().toLowerCase() === me.programme.trim().toLowerCase();
  let ch = [];
  if (day) {
    const names = Object.fromEntries(day.halls.map((h) => [h.id, h.name]));
    ch = [
      ...day.classes.filter((c) => c.released && mineProg(c.programme)).map((c) => ({ date: today, s: c.start_min, e: c.end_min, hall: names[c.hall_id], course: c.course, prog: c.programme, chip: changeChip(c) })),
      ...day.moved.filter((c) => mineProg(c.programme)).map((c) => ({ date: today, s: c.start_min, e: c.end_min, hall: names[c.hall_id], course: c.course, prog: c.programme, chip: 'Moved here' }))
    ].sort((a, b) => a.s - b.s);
  }
  const unreadMsgs = notes.filter((n) => !n.is_read && n.link === 'msg').length;
  $('dPend').textContent = pend.length; $('dBook').textContent = appr.length; $('dChg').textContent = ch.length; $('dMsgCnt').textContent = unreadMsgs;
  setBadge('vMine', pend.length); setBadge('vMsg', unreadMsgs);
  const shown = [...pend, ...appr].sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min).slice(0, 4);
  $('dPendList').innerHTML = shown.length ? shown.map((b) => brow(b, esc(b.purpose), `<button class="btn sm" data-rview="1">View</button>${b.status === 'pending' ? `<button class="btn sm ghost" data-rcancel="${b.id}" data-st="pending">Cancel</button>` : b.status === 'approved' && !b.cancel_req ? `<button class="btn sm ghost" data-rcancel="${b.id}" data-st="approved">Ask to cancel</button>` : ''}`)).join('')
    : infoBox('No booking requests yet. Use Search halls to find a hall and send a request.');
  $('dChgList').innerHTML = ch.length ? ch.map(crow).join('') : infoBox('No class changes yet.');
  renderActivity(notes);
}
async function loadStaffDash() {
  loadMaint();
  const [ov, bk, notes] = await Promise.all([api('/api/admin/overview'), has('bookings.view') || has('bookings.decide') ? api('/api/bookings').catch(() => []) : [], api('/api/notifications').catch(() => [])]);
  const pend = bk.filter((b) => b.status === 'pending' || b.status === 'alternative'), appr = bk.filter((b) => b.status === 'approved');
  $('dPend').textContent = pend.length; $('dBook').textContent = appr.length; $('dChg').textContent = ov.changes.length; $('dMsgCnt').textContent = has('messages.handle') ? ov.unread || 0 : 0;
  const age = (ms) => { const h = Math.floor((Date.now() - ms) / 3600000); return h >= 24 ? `waiting ${Math.floor(h / 24)}d` : h >= 1 ? `waiting ${h}h` : 'new'; };
  $('dPendList').innerHTML = pend.length ? pend.map((b) => brow(b, `${esc(b.purpose)} <small>${esc(b.by_name)} · ${esc(b.programme)} · ${age(b.created)}</small>`,
    b.status === 'pending' && has('bookings.decide') ? `<button class="btn sm" data-dec="approve" data-id="${b.id}">Approve</button><button class="btn sm ghost" data-dec="reject" data-id="${b.id}">Reject</button><button class="btn sm ghost" data-dec="alternative" data-id="${b.id}" data-hall="${esc(b.hall)}" data-date="${b.date}" data-s="${hhmm(b.start_min)}" data-e="${hhmm(b.end_min)}">Suggest alternative</button>` : '')).join('')
    : infoBox(has('bookings.view') ? 'No requests waiting.' : 'You have not been given access to booking requests.');
  $('dBookList').innerHTML = appr.length ? appr.map((b) => brow(b,
    `${esc(b.purpose)} <small>${esc(b.by_name)}</small>${b.cancel_req ? ` <span class="pill warn">Cancellation requested: ${esc(b.cancel_req)}</span>` : ''}${b.ext_end ? ` <span class="pill ${b.ext_conflict ? 'warn' : 'pend'}">Extension to ${hhmm(b.ext_end)}${b.ext_conflict ? ' · CONFLICT: ' + esc(b.ext_conflict) : ''}</span>` : ''}${b.release_req ? ' <span class="pill warn">Reported empty</span>' : ''}${b.alt_state === 'accepted' ? ` <span class="pill warn">Replacement awaiting approval: ${esc(b.alt_hall_name)}</span>` : ''}${b.alt_state === 'offered' ? ' <span class="pill pend">Replacement offered to rep</span>' : ''}`,
    `${has('bookings.decide') && b.ext_end ? `<button class="btn sm" data-ext="1" data-id="${b.id}">Approve extension</button><button class="btn sm ghost" data-ext="0" data-id="${b.id}">Reject extension</button>` : ''}${has('bookings.decide') && b.alt_state === 'accepted' ? `<button class="btn sm" data-mnt="1" data-id="${b.id}">Approve replacement</button><button class="btn sm ghost" data-mnt="0" data-id="${b.id}">Reject</button>` : ''}${has('bookings.cancel') && b.release_req ? `<button class="btn sm" data-rel="${b.id}">Confirm early release</button>` : ''}${has('bookings.cancel') ? `<button class="btn sm ghost" data-cancel="${b.id}">${b.cancel_req ? 'Confirm cancellation' : 'Cancel booking'}</button>` : ''}`)).join('') : infoBox('No approved bookings.');
  $('dChgList').innerHTML = ov.changes.length ? ov.changes.map((c) => crow({ date: c.date, s: c.start_min, e: c.end_min, hall: c.hall, course: c.course, prog: c.programme, chip: changeChip(c), by: c.by_name || 'unknown' })).join('') : infoBox('No class changes yet.');
  renderActivity(notes);
  $('dMsgPanel').hidden = !has('messages.handle');
  if (has('messages.handle')) {
    const ms = await api('/api/messages');
    $('dUnread').hidden = !ov.unread; $('dUnread').textContent = ov.unread;
    $('dMsgList').innerHTML = ms.length ? ms.map((m) => `<div class="item ${m.is_read ? '' : 'unread'}"><div class="l1"><b>${esc(m.name)}</b> <small>${esc(m.programme)} · ${when(m.created)}</small></div><div class="l2">${esc(m.body)}</div>${m.reply ? `<div class="reply">Reply: ${esc(m.reply)}</div>` : ''}
      <div class="acts"><button class="mini" data-reply="${m.id}">Reply</button>${m.is_read ? '' : `<button class="mini" data-read="${m.id}">Mark read</button>`}</div></div>`).join('') : infoBox('No messages.');
  }
}
$('vDash').addEventListener('click', async (e) => {
  const card = e.target.closest('.statc');
  if (card) {
    const t = me.role === 'pr' ? card.dataset.rep : card.dataset.staff;
    if (t && t.startsWith('v')) go(t); else if (t && $(t) && !$(t).hidden) $(t).scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const act = e.target.closest('.act[data-link]');
  if (act) { const t = LINKS[act.dataset.link]; if (t && document.querySelector(`#nav [data-v=${t}]`)) go(t); else go('vNotif'); return; }
  const g = e.target.closest('[data-goto]'); if (g) return go(g.dataset.goto);
  if (e.target.closest('#ctaGo')) return go('vFind');
  if (e.target.closest('#dqGo')) {
    $('date').value = $('dqDate').value || localDate(); $('time').value = $('dqTime').value || $('time').value;
    $('group').value = $('dqGroup').value; $('seats').value = $('dqSeats').value;
    return go('vFind');
  }
  const btn = e.target.closest('button'); if (!btn) return;
  const d = btn.dataset;
  try {
    if (d.rview) return go('vMine');
    if (d.rcancel) {
      const r = ask(d.st === 'approved' ? 'Reason for asking to cancel (needed for approved bookings):' : 'Reason (optional):'); if (r === null) return;
      await api(`/api/bookings/${d.rcancel}/cancel`, 'POST', { reason: r });
    } else if (d.dec) {
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
    else if (d.ext) { const r = ask(d.ext === '1' ? 'Reason for approving the extension:' : 'Reason for rejecting the extension:'); if (!r) return; await api(`/api/bookings/${d.id}/extension`, 'POST', { approve: d.ext === '1', reason: r }); }
    else if (d.mnt) { const r = ask(d.mnt === '1' ? 'Reason for approving the replacement hall:' : 'Reason for rejecting it:'); if (!r) return; await api(`/api/bookings/${d.id}/maint-decision`, 'POST', { approve: d.mnt === '1', reason: r }); }
    else if (d.rel) { const r = ask('How do you know the hall is empty? (required)'); if (!r) return; await api(`/api/bookings/${d.rel}/release`, 'POST', { reason: r }); }
    else if (d.bclear) { const r = ask('Reason for restoring the hall:'); if (!r) return; await api(`/api/hall-blocks/${d.bclear}/clear`, 'POST', { reason: r }); }
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
const LINKS = { dash: 'vDash', mine: 'vMine', msg: 'vMsg', audit: 'vAudit', tt: 'vTT', cal: 'vCal', sec: 'vSec' };
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

// ---------- hall maintenance (admins with the halls permission) ----------
async function loadMaint() {
  $('dMaintPanel').hidden = !has('halls.manage'); if (!has('halls.manage')) return;
  try {
    const bl = await api('/api/hall-blocks');
    $('dMaintList').innerHTML = bl.length ? bl.map((b) => `<div class="item"><div class="l1"><b>${esc(b.hall)}</b> unavailable</div><div class="l2">${b.start_at.replace('T', ' ')} → ${b.end_at ? b.end_at.replace('T', ' ') : 'until cleared'} <small>${esc(b.reason)}</small></div>
      <div class="acts"><button class="mini" data-bclear="${b.id}">Restore hall</button></div></div>`).join('') : infoBox('No halls are marked unavailable.');
  } catch (e) { $('dMaintList').innerHTML = infoBox(esc(e.message)); }
}
$('mForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/hall-blocks', 'POST', { hall: $('mHall').value, start_at: $('mFrom').value, end_at: $('mTo').value || null, reason: $('mWhy').value });
    $('mForm').reset(); say('mMsg', `Done. ${r.affected} existing booking(s) affected. Those reps were told and offered a replacement hall; nothing was cancelled.`, true); loadMaint();
  } catch (err) { say('mMsg', err.message); }
});
$('dMaintList').addEventListener('click', async (e) => {
  const id = e.target.dataset.bclear; if (!id) return;
  const r = ask('Reason for restoring the hall:'); if (!r) return;
  try { await api(`/api/hall-blocks/${id}/clear`, 'POST', { reason: r }); loadMaint(); } catch (err) { alert(err.message); }
});

// ---------- timetables: submit (rep) and review + versions (Super Admin) ----------
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function loadTT() {
  $('ttPr').hidden = me.role !== 'pr'; $('ttSuper').hidden = me.role !== 'super'; $('subReview').hidden = true;
  try {
    if (me.role === 'pr') {
      $('myProg').textContent = me.programme;
      const [t, s] = await Promise.all([api('/api/my-timetable'), api('/api/timetable/submissions')]);
      $('myTT').innerHTML = t.length ? t.map((x) => `<div class="ln"><span><span class="t">${DN[x.day]} ${hhmm(x.start_min)}–${hhmm(x.end_min)}</span>${esc(x.course)}</span><small>${esc(x.hall)}</small></div>`).join('') : infoBox('Your programme has no official timetable yet.');
      $('tsList').innerHTML = s.length ? s.map((x) => `<div class="item"><div class="l1">${esc(x.filename || 'file')} · ${x.row_count} rows <small>${when(x.created)}</small></div><div class="l3"><span class="chip ${x.status === 'approved' ? '' : x.status === 'pending' ? 'line' : 'muted'}">${x.status === 'pending' ? 'Waiting for the Super Admin' : x.status}</span></div>${x.reason ? `<div class="reply">${esc(x.reason)}</div>` : ''}</div>`).join('') : infoBox('Nothing submitted yet.');
    } else {
      const [s, v] = await Promise.all([api('/api/timetable/submissions'), api('/api/timetable/versions')]);
      $('subList').innerHTML = s.length ? s.map((x) => `<div class="item"><div class="l1"><b>${esc(x.programme)}</b> · ${x.row_count} rows <small>${esc(x.by_name)} · ${when(x.created)}</small></div>
        <div class="l3"><span class="chip ${x.status === 'pending' ? 'warn' : 'muted'}">${x.status}</span>${x.report.length ? `<span class="chip warn">${x.report.length} conflict(s)</span>` : ''}</div>${x.reason ? `<div class="reply">${esc(x.reason)}</div>` : ''}
        ${x.status === 'pending' ? `<div class="acts"><button class="mini" data-review="${x.id}">Review</button></div>` : ''}</div>`).join('') : '<div class="empty">Nothing to review.</div>';
      $('verList').innerHTML = v.length ? v.map((x) => `<div class="item"><div class="l1"><b>#${x.id}</b> · ${when(x.created)} · ${x.n} classes</div><div class="l2"><small>${esc(x.note)} · by ${esc(x.created_by)}</small></div><div class="acts"><button class="mini" data-restore="${x.id}">Restore this version</button></div></div>`).join('') : infoBox('No versions yet. One is saved before the first change.');
    }
  } catch (e) { (me.role === 'pr' ? $('myTT') : $('subList')).innerHTML = infoBox(esc(e.message)); }
}
$('tsGo').addEventListener('click', async () => {
  const f = $('tsFile').files[0]; if (!f) return say('tsMsg', 'Choose a CSV file first.');
  try { const r = await api('/api/timetable/submissions', 'POST', { name: f.name, csv: await f.text() }); say('tsMsg', `Submitted ${r.rows} rows. The Super Admin will review them.`, true); $('tsFile').value = ''; loadTT(); }
  catch (err) { say('tsMsg', err.message + (err.details ? ' ' + err.details.join(' ') : '')); }
});
$('ttSuper').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.review) {
      const p = await api('/api/timetable/submissions/' + d.review);
      $('subReview').hidden = false;
      $('subReview').innerHTML = `<h2>${esc(p.programme)}: ${p.total} rows</h2><p class="muted">Publishing replaces only this programme's ${p.replaces} existing classes. A copy of the current timetable is saved first.</p>
        ${p.conflicts.length ? `<div class="reply"><b>${p.conflicts.length} conflict(s):</b><br>${p.conflicts.map(esc).join('<br>')}</div>` : '<p class="msg ok">No conflicts found.</p>'}
        <div class="scroll" style="max-height:220px">${p.rows.map((r) => `<div class="ln"><span><span class="t">${r[1]} ${r[2]}–${r[3]}</span>${esc(r[4])}</span><small>${esc(r[0])}</small></div>`).join('')}</div>
        <div class="acts"><button class="btn" data-decide="approve" data-id="${d.review}" data-n="${p.conflicts.length}">Approve and publish</button><button class="btn ghost" data-decide="reject" data-id="${d.review}">Reject</button></div>`;
      $('subReview').scrollIntoView({ behavior: 'smooth' });
    } else if (d.decide) {
      const force = d.decide === 'approve' && +d.n > 0;
      if (force && !confirm(`${d.n} conflict(s) were found. Publish anyway? Existing approved bookings are kept and flagged, not deleted.`)) return;
      const r = ask(d.decide === 'approve' ? 'Reason for approving:' : 'Reason for rejecting:'); if (!r) return;
      await api(`/api/timetable/submissions/${d.id}/decision`, 'POST', { decision: d.decide, reason: r, force }); loadTT();
    } else if (d.restore) {
      const r = ask(`Restore version #${d.restore}? This replaces the whole official timetable (a copy of the current one is saved first). Reason:`); if (!r) return;
      await api(`/api/timetable/versions/${d.restore}/restore`, 'POST', { reason: r }); alert('Restored.'); loadTT();
    }
  } catch (err) { alert(err.message); }
});

// ---------- academic calendar + yearly transition (Super Admin) ----------
async function loadCal() {
  try {
    const ys = await api('/api/calendar');
    $('pYear').innerHTML = ys.map((y) => `<option value="${y.id}">${esc(y.label)}</option>`).join('');
    $('calList').innerHTML = ys.length ? ys.map((y) => `<div class="item"><div class="l1"><b>${esc(y.label)}</b> <small>${fmtDate(y.start_date)} → ${fmtDate(y.end_date)}</small></div>
      <div class="l3"><span class="chip ${y.state === 'upcoming' ? 'line' : y.state === 'current' ? '' : 'muted'}">${y.state}</span>${y.state === 'upcoming' && y.auto ? '<small>Cohorts advance automatically on the start date</small>' : ''}${y.transitioned_at ? `<small>Cohorts advanced ${when(y.transitioned_at)}</small>` : ''}</div>
      ${y.periods.map((p) => `<div class="ln"><span><span class="t">${esc(p.kind)}</span>${esc(p.label)} <small>${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}</small></span><button class="mini" data-delper="${p.id}">Remove</button></div>`).join('')}
      <div class="acts"><button class="mini" data-yedit="${y.id}" data-s="${y.start_date}" data-e="${y.end_date}">Change dates</button>${y.transitioned_at ? '' : `<button class="mini" data-trans="${y.id}" data-l="${esc(y.label)}">Run year change now</button>`}</div></div>`).join('') : '<div class="empty">No academic years yet.</div>';
  } catch (e) { $('calList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('yrForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const r = await api('/api/calendar/years', 'POST', { label: $('yLabel').value, start_date: $('yStart').value, end_date: $('yEnd').value }); $('yrForm').reset(); say('yMsg', r.auto_transition ? 'Added. Cohorts will advance automatically on the start date.' : 'Added. This year has already started, so nothing advances automatically.', true); loadCal(); } catch (err) { say('yMsg', err.message); }
});
$('perForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/calendar/periods', 'POST', { year_id: +$('pYear').value, kind: $('pKind').value, label: $('pLabel').value, start_date: $('pFrom').value, end_date: $('pTo').value }); $('perForm').reset(); say('pMsg', 'Added.', true); loadCal(); } catch (err) { say('pMsg', err.message); }
});
$('calList').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.delper) { if (!confirm('Remove this period?')) return; await api('/api/calendar/periods/' + d.delper, 'DELETE'); }
    else if (d.yedit) {
      const s = ask('Start date (YYYY-MM-DD):', d.s); if (!s) return; const en = ask('End date (YYYY-MM-DD):', d.e); if (!en) return;
      try { await api('/api/calendar/years/' + d.yedit, 'PATCH', { start_date: s, end_date: en }); }
      catch (err) { if (!err.impact) throw err; if (!confirm(err.impact + '\n\nApply the change anyway?')) return; await api('/api/calendar/years/' + d.yedit, 'PATCH', { start_date: s, end_date: en, confirm: true }); }
    } else if (d.trans) {
      const c = ask(`This advances EVERY cohort one level, retires Level 400 accounts and creates new Level 100 accounts for ${d.l}. It can only run once. Type RUN to confirm:`); if (c !== 'RUN') return;
      const r = await api(`/api/calendar/years/${d.trans}/transition`, 'POST', { confirm: 'RUN' });
      $('calResult').hidden = false;
      $('calResult').innerHTML = `<b>Year change done.</b> Copy these new Level 100 logins now. Passwords are shown only once. Give them to the Departmental Heads.<pre>${r.created.map((a) => `${a.username}   ${a.temp_password}   (${a.programme})`).join('\n') || 'No new accounts were needed.'}</pre>${r.skipped.length ? `<p>Check by hand (no level found): ${r.skipped.join(', ')}</p>` : ''}<p class="muted">The previous timetable stays active until you publish the new one.</p>`;
    } else return;
    loadCal();
  } catch (err) { alert(err.message); }
});

// ---------- Super Admin security dashboard ----------
async function loadSec() {
  try {
    const [s, rs, ps] = await Promise.all([api('/api/security'), api('/api/reports'), api('/api/petitions')]);
    $('sRep').textContent = s.counts.reports; $('sPet').textContent = s.counts.petitions; $('sSub').textContent = s.counts.submissions;
    $('secSessions').innerHTML = s.sessions.length ? s.sessions.map((x) => `<div class="item"><div class="l1"><b>${esc(x.name)}</b> <small>${ROLE[x.role]}</small></div><div class="l2"><small>${esc(x.device || 'unknown device')}${x.last_seen ? ' · last active ' + when(x.last_seen) : ''}</small></div>
      <div class="l3"><span class="chip ${x.working ? '' : 'muted'}">${x.working ? 'Working now' : 'Session open, idle'}</span></div>
      ${x.role !== 'super' ? `<div class="acts"><button class="mini" data-freeze="${x.user_id}">Freeze</button><button class="mini" data-revoke="${x.user_id}">Sign out</button></div>` : ''}</div>`).join('') : infoBox('No administrators are signed in.');
    $('secReports').innerHTML = rs.length ? rs.map((r) => `<div class="item ${r.status === 'resolved' ? '' : 'unread'}"><div class="l1"><b>${esc(r.category)}</b> <small>from ${esc(r.by_name)} (${ROLE[r.by_role]}) · ${when(r.created)}</small></div><div class="l2">${esc(r.body)}</div>
      ${r.findings ? `<div class="reply">Findings: ${esc(r.findings)}</div>` : ''}<div class="l3"><span class="chip ${r.status === 'resolved' ? 'muted' : 'warn'}">${r.status}</span></div>
      ${r.status !== 'resolved' ? `<div class="acts"><button class="mini" data-rep="investigating" data-id="${r.id}">Investigating</button><button class="mini" data-rep="resolved" data-id="${r.id}">Resolve</button></div>` : ''}</div>`).join('') : infoBox('No reports.');
    $('secPetitions').innerHTML = ps.length ? ps.map((p) => `<div class="item ${p.status === 'open' ? 'unread' : ''}"><div class="l1"><b>${esc(p.ref || 'General')}</b> <small>from ${esc(p.by_name)} · ${when(p.created)}</small></div><div class="l2">${esc(p.body)}</div>${p.response ? `<div class="reply">Your response: ${esc(p.response)}</div>` : ''}
      ${p.status === 'open' ? `<div class="acts"><button class="mini" data-pet="1" data-id="${p.id}">Accept</button><button class="mini" data-pet="0" data-id="${p.id}">Decline</button></div>` : `<div class="l3"><span class="chip muted">${p.status}</span></div>`}</div>`).join('') : infoBox('No petitions.');
    $('secAlerts').innerHTML = s.alerts.length ? s.alerts.map((a) => `<div class="item"><div class="l1"><b>${esc(a.action.replace(/_/g, ' '))}</b> <span class="chip ${a.severity === 'critical' ? 'warn' : 'muted'}">${a.severity}</span></div><div class="l2">${esc(a.target)} <small>${esc(a.actor_name)} · ${when(a.created)}</small></div>${a.reason ? `<div class="reply">${esc(a.reason)}</div>` : ''}</div>`).join('') : infoBox('No alerts.');
  } catch (e) { $('secSessions').innerHTML = infoBox(esc(e.message)); }
}
$('vSec').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.freeze) { const r = ask('Reason for freezing (not a finding of misconduct):'); if (!r) return; await api(`/api/users/${d.freeze}/status`, 'POST', { status: 'frozen', reason: r }); }
    else if (d.revoke) { const r = ask('Reason for signing this account out:'); if (!r) return; await api(`/api/users/${d.revoke}/revoke`, 'POST', { reason: r }); }
    else if (d.rep) { const f = ask('Findings or notes:'); if (f === null) return; await api(`/api/reports/${d.id}/update`, 'POST', { status: d.rep, findings: f }); }
    else if (d.pet) { const r = ask('Your response:'); if (!r) return; await api(`/api/petitions/${d.id}/decide`, 'POST', { accept: d.pet === '1', response: r }); }
    else return;
    loadSec();
  } catch (err) { alert(err.message); }
});
$('bkDl').addEventListener('click', () => { location.href = '/api/backup'; });

// ---------- confidential report (everyone) + petition (Main Admin) ----------
async function loadRep() {
  $('petPanel').hidden = me.role !== 'main';
  try {
    const rs = await api('/api/reports');
    $('repList').innerHTML = rs.length ? rs.map((r) => `<div class="item"><div class="l1">${esc(r.category)} <small>${when(r.created)}</small></div><div class="l3"><span class="chip ${r.status === 'resolved' ? 'muted' : 'line'}">${r.status}</span></div></div>`).join('') : '<div class="empty">You have not sent any reports.</div>';
    if (me.role === 'main') { const ps = await api('/api/petitions'); $('petList').innerHTML = ps.length ? ps.map((p) => `<div class="item"><div class="l1"><b>${esc(p.ref || 'General')}</b> <span class="chip ${p.status === 'open' ? 'line' : 'muted'}">${p.status}</span></div><div class="l2">${esc(p.body)}</div>${p.response ? `<div class="reply">Super Admin: ${esc(p.response)}</div>` : ''}</div>`).join('') : '<div class="empty">No petitions.</div>'; }
  } catch (e) { $('repList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('repForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/reports', 'POST', { category: $('repCat').value, body: $('repBody').value }); $('repForm').reset(); say('repMsg', 'Sent privately to the Super Admin.', true); loadRep(); } catch (err) { say('repMsg', err.message); }
});
$('petForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/petitions', 'POST', { ref: $('petRef').value, body: $('petBody').value }); $('petForm').reset(); say('petMsg', 'Sent to the Super Admin.', true); loadRep(); } catch (err) { say('petMsg', err.message); }
});

// ---------- start ----------
(async () => {
  $('group').innerHTML = '<option value="">All halls</option>' + ['SWLT', 'NLT', 'LT', 'CALC'].map((g) => `<option>${g}</option>`).join('');
  try { me = await api('/api/me'); showApp(); } catch (e) { showLogin(); }
})();
