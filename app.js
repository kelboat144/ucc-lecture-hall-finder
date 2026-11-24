const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toM = (t) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const KIND = { online: 'Online', cancelled: 'Cancelled', postponed: 'Postponed' };
let me = null, data = { halls: [], classes: [], moved: [], bookings: [] }, tab = 'free', openHall = null, postId = null, view = 'vFind';

async function api(url, method = 'GET', body) {
  if (method !== 'GET' && body === undefined) body = {};
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please sign in again.'); }
  if (!res.ok) { const err = new Error(j.error || 'Request failed.'); err.details = j.details; throw err; }
  return j;
}
const say = (id, text, ok) => { const el = $(id); if (!el) return; el.textContent = text; el.className = 'msg' + (id === 'bkMsg' ? ' wide' : '') + (text ? (ok ? ' ok' : ' err') : ''); };

// ---------- theme (light / dark) ----------
function applyTheme(t) { document.documentElement.dataset.theme = t; document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#081226' : '#0f2a4f'; }
let savedTheme = null; try { savedTheme = localStorage.getItem('theme'); } catch (e) {}
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(t);
  try { localStorage.setItem('theme', t); } catch (e) {}
});

// ---------- shell: hamburger drawer ----------
function menu(open) { $('drawer').classList.toggle('on', open); $('scrim').hidden = !open; $('menuBtn').setAttribute('aria-expanded', open); }
$('menuBtn').addEventListener('click', () => menu(!$('drawer').classList.contains('on')));
$('scrim').addEventListener('click', () => menu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu(false); });
let unread = 0;
function buildNav() {
  const tabs = me.role === 'admin' ? [['vDash', 'Dashboard'], ['vFind', 'Find a hall'], ['vAdmin', 'Manage'], ['vAccount', 'Account']]
    : [['vFind', 'Find a hall'], ['vMine', 'My bookings'], ['vMsg', 'Message admin'], ['vAccount', 'Account']];
  $('nav').innerHTML = tabs.map(([id, t]) => `<button data-v="${id}" class="${id === view ? 'on' : ''}">${t}${id === 'vDash' && unread ? `<span class="dot">${unread}</span>` : ''}</button>`).join('');
}
function showLogin() { me = null; menu(false); $('appView').hidden = true; $('loginView').hidden = false; $('lp').value = ''; }
function showApp() {
  $('loginView').hidden = true; $('appView').hidden = false;
  $('avatar').textContent = me.name.trim().charAt(0).toUpperCase();
  $('whoName').textContent = me.name; $('whoProg').textContent = me.role === 'admin' ? 'Administrator' : me.programme;
  $('filters').hidden = innerWidth < 900;
  buildNav(); go(me.role === 'admin' ? 'vDash' : 'vFind');
}
function go(v) {
  view = v; menu(false);
  ['vDash', 'vFind', 'vMine', 'vMsg', 'vAdmin', 'vAccount'].forEach((id) => ($(id).hidden = id !== v));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  scrollTo(0, 0);
  if (v === 'vFind') load(); if (v === 'vMine') loadMine(); if (v === 'vAdmin') loadAdmin(); if (v === 'vDash') loadDash(); if (v === 'vMsg') loadMsgs();
}
$('nav').addEventListener('click', (e) => { if (e.target.dataset.v) go(e.target.dataset.v); });
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); say('loginMsg', '');
  try { me = await api('/api/login', 'POST', { username: $('lu').value, password: $('lp').value }); showApp(); }
  catch (err) { say('loginMsg', err.message); }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', 'POST', {}); } catch (e) {} showLogin(); });

// ---------- finder ----------
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
  let rows = data.halls.filter((h) => (!grp || h.grp === grp) && h.seats >= minSeats && (!q || h.name.toLowerCase().replace(/\s+/g, '').includes(q)))
    .map((h) => ({ h, s: status(h, m) }));
  rows = rows.filter((x) => !x.s.free || !dur || x.s.until === null || x.s.until - m >= dur);
  const nFree = rows.filter((x) => x.s.free).length;
  $('stats').innerHTML = `<div class="stat gold"><b>${nFree}</b><span>Free</span></div><div class="stat"><b>${rows.length - nFree}</b><span>In use</span></div><div class="stat"><b>${rows.length}</b><span>Halls</span></div>`;
  const names = Object.fromEntries(data.halls.map((h) => [h.id, h.name]));
  const ch = [
    ...data.classes.filter((c) => c.released).map((c) => ({ s: c.start_min, e: c.end_min, hall: names[c.hall_id], course: c.course, prog: c.programme,
      chip: KIND[c.kind] + (c.kind === 'postponed' ? ' to ' + fmtDate(c.new_date) + ' ' + hhmm(c.new_start) : '') })),
    ...data.moved.map((c) => ({ s: c.start_min, e: c.end_min, hall: names[c.hall_id], course: c.course, prog: c.programme, chip: 'Moved here from ' + fmtDate(c.from_date) })),
  ].sort((a, b) => a.s - b.s);
  $('changes').innerHTML = ch.length ? `<div class="panel changes"><h2>Changes on ${fmtDate($('date').value)} (${ch.length})</h2><div class="list">${ch.map((x) =>
    `<div class="ln"><span><span class="t">${hhmm(x.s)}–${hhmm(x.e)}</span><b>${esc(x.hall)}</b> · ${esc(x.course)} <small>${esc(x.prog)}</small></span><span class="chip">${esc(x.chip)}</span></div>`).join('')}</div></div>` : '';
  const shown = rows.filter((x) => (tab === 'all' ? true : tab === 'free' ? x.s.free : !x.s.free))
    .sort((a, b) => b.s.free - a.s.free || (b.s.until ?? 1e9) - (a.s.until ?? 1e9));
  $('list').innerHTML = shown.length ? shown.map(({ h, s }) => `
    <article class="hall ${openHall === h.id ? 'open' : ''}" data-id="${h.id}" tabindex="0" role="button" aria-expanded="${openHall === h.id}">
      <div class="row"><div><h3>${esc(h.name)}</h3><p>${h.seats ? h.seats + ' seats' : 'Seats not set'}</p></div>
      <span class="badge ${s.free ? 'free' : 'taken'}">${s.free ? (s.until ? 'Free until ' + hhmm(s.until) : 'Free all day') : esc(s.tag) + ' · ' + hhmm(s.until)}</span></div>
      ${timeline(s.it, m)}
      ${openHall === h.id ? detail(h, s, m) : ''}
    </article>`).join('') : '<div class="empty">No halls match. Try another time, switch tabs, or loosen the filters.</div>';
}

function detail(h, s, m) {
  const date = $('date').value, future = date >= localDate();
  const can = (c) => me.role === 'admin' || (me.programme && c.programme.trim().toLowerCase() === me.programme.trim().toLowerCase());
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
    ...data.bookings.filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, html: `Booked by ${esc(b.by_name)} · ${esc(b.purpose)}`,
      btn: b.user_id === me.id || me.role === 'admin' ? `<button class="mini" data-act="cancel" data-id="${b.id}">Cancel booking</button>` : '', form: '' })),
  ].sort((a, b) => a.s - b.s);
  const from = s.free ? m : s.until, to = s.free ? Math.min(m + 60, s.until ?? m + 60) : s.until + 60;
  return `<div class="detail">
    ${lines.length ? lines.map((l) => `<div class="ln"><span><span class="t">${hhmm(l.s)}–${hhmm(l.e)}</span>${l.html}</span>${l.btn}${l.form}</div>`).join('') : '<p class="muted">No classes or bookings on this date.</p>'}
    <div class="bk">
      <input class="wide" id="bkPurpose" placeholder="Book it: purpose (e.g. CSC 205 group study)" maxlength="80" style="grid-column:1/-1">
      <input type="time" id="bkFrom" value="${hhmm(Math.min(from, 1439))}"><input type="time" id="bkTo" value="${hhmm(Math.min(to, 1439))}">
      <button class="btn" data-act="book" data-id="${h.id}">Book this hall</button>
      <p class="msg wide" id="bkMsg" style="grid-column:1/-1"></p>
    </div></div>`;
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
      else if (act === 'cancel') await api('/api/bookings/' + id, 'DELETE');
      else if (act === 'book') await api('/api/bookings', 'POST', { hall_id: +id, date, start: $('bkFrom').value, end: $('bkTo').value, purpose: $('bkPurpose').value });
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
[['tFree', 'free'], ['tBusy', 'busy'], ['tAll', 'all']].forEach(([id, v]) => $(id).addEventListener('click', () => {
  tab = v; ['tFree', 'tBusy', 'tAll'].forEach((x) => $(x).classList.toggle('on', x === id)); render();
}));

// ---------- bookings list ----------
async function loadMine() {
  try {
    const rows = await api('/api/bookings'), adm = me.role === 'admin';
    $('mine').innerHTML = rows.length ? `<div class="tbl panel"><table><tr><th>Date</th><th>Time</th><th>Hall</th><th>Purpose</th>${adm ? '<th>By</th>' : ''}<th></th></tr>` +
      rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${hhmm(r.start_min)}–${hhmm(r.end_min)}</td><td>${esc(r.hall)}</td><td>${esc(r.purpose)}</td>${adm ? `<td>${esc(r.by_name)}</td>` : ''}<td><button class="mini" data-cancel="${r.id}">Cancel</button></td></tr>`).join('') + '</table></div>'
      : '<div class="empty">No upcoming bookings.</div>';
  } catch (e) { $('mine').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('mine').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel; if (!id || !confirm('Cancel this booking?')) return;
  try { await api('/api/bookings/' + id, 'DELETE'); loadMine(); } catch (err) { alert(err.message); }
});

// ---------- admin ----------
async function loadAdmin() {
  try {
    const [users, halls, count] = await Promise.all([api('/api/users'), api('/api/day?date=' + localDate()), api('/api/timetable/count')]);
    $('ttCount').textContent = `${count.n} timetable entries loaded.`;
    $('users').innerHTML = '<table><tr><th>Name</th><th>Username</th><th>Role / programme</th><th></th></tr>' + users.map((u) =>
      `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'Administrator' : esc(u.programme)}</td>
      <td><button class="mini" data-pw="${u.id}">Reset password</button> ${u.id === me.id ? '' : `<button class="mini" data-del="${u.id}">Delete</button>`}</td></tr>`).join('') + '</table>';
    $('halls').innerHTML = halls.halls.map((h) => `<label>${esc(h.name)}<input type="number" min="0" value="${h.seats}" data-hall="${h.id}"></label>`).join('');
  } catch (e) { say('userMsg', e.message); }
}
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/users', 'POST', { name: $('un').value, username: $('uu').value, role: $('ur').value, programme: $('up').value, password: $('upw').value });
    $('userForm').reset(); say('userMsg', 'User created. Share the temporary password privately.', true); loadAdmin();
  } catch (err) { say('userMsg', err.message); }
});
$('users').addEventListener('click', async (e) => {
  try {
    if (e.target.dataset.del && confirm('Delete this user and their bookings?')) { await api('/api/users/' + e.target.dataset.del, 'DELETE'); loadAdmin(); }
    if (e.target.dataset.pw) { const pw = prompt('New temporary password (8+ characters):'); if (pw) { await api(`/api/users/${e.target.dataset.pw}/password`, 'PATCH', { password: pw }); alert('Password reset.'); } }
  } catch (err) { alert(err.message); }
});
$('halls').addEventListener('change', async (e) => {
  if (!e.target.dataset.hall) return;
  try { await api('/api/halls/' + e.target.dataset.hall, 'PATCH', { seats: +e.target.value }); } catch (err) { alert(err.message); }
});
$('ttGo').addEventListener('click', async () => {
  const files = [...$('ttFile').files]; if (!files.length) return say('ttMsg', 'Choose one or more CSV files first.');
  try {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, csv: await f.text() })));
    const r = await api('/api/timetable/import', 'POST', { files: payload, replace: $('ttReplace').checked });
    say('ttMsg', `${r.imported} classes imported from ${r.files} file(s).` + (r.skipped ? ` ${r.skipped} duplicate rows skipped.` : ''), true);
    $('ttFile').value = ''; loadAdmin();
  } catch (err) { say('ttMsg', err.message + (err.details ? ' ' + err.details.join(' ') : '')); }
});

// ---------- admin dashboard ----------
const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
async function loadDash() {
  try {
    const [ov, bk, ms] = await Promise.all([api('/api/admin/overview'), api('/api/bookings'), api('/api/messages')]);
    unread = ov.unread; buildNav();
    $('dChanges').textContent = ov.changes.length; $('dBookings').textContent = bk.length; $('dUnread').textContent = ov.unread;
    $('dChangeList').innerHTML = ov.changes.length ? ov.changes.map((c) => `<div class="item"><div class="l1"><b>${fmtDate(c.date)}</b> · ${hhmm(c.start_min)}–${hhmm(c.end_min)} · ${esc(c.hall)}</div>
      <div class="l2">${esc(c.course)} <small>${esc(c.programme)}</small></div>
      <div class="l3"><span class="chip">${KIND[c.kind]}${c.kind === 'postponed' ? ' to ' + fmtDate(c.new_date) + ' ' + hhmm(c.new_start) + '–' + hhmm(c.new_end) : ''}</span><small>by ${esc(c.by_name || 'unknown')}${c.created ? ' · ' + when(c.created) : ''}</small></div></div>`).join('')
      : '<p class="muted">No class changes yet.</p>';
    $('dBookList').innerHTML = bk.length ? bk.map((b) => `<div class="item"><div class="l1"><b>${fmtDate(b.date)}</b> · ${hhmm(b.start_min)}–${hhmm(b.end_min)} · ${esc(b.hall)}</div>
      <div class="l2">${esc(b.purpose)}</div><div class="l3"><small>by ${esc(b.by_name)}</small><button class="mini" data-cancel="${b.id}">Cancel booking</button></div></div>`).join('')
      : '<p class="muted">No upcoming bookings.</p>';
    $('dMsgList').innerHTML = ms.length ? ms.map((m) => `<div class="item ${m.is_read ? '' : 'unread'}"><div class="l1"><b>${esc(m.name)}</b> <small>${esc(m.programme)} · ${when(m.created)}</small></div>
      <div class="l2">${esc(m.body)}</div>${m.reply ? `<div class="reply">You replied: ${esc(m.reply)}</div>` : ''}
      <div class="l3"><button class="mini" data-reply="${m.id}">Reply</button>${m.is_read ? '' : `<button class="mini" data-read="${m.id}">Mark read</button>`}<button class="mini" data-delmsg="${m.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">No messages.</p>';
  } catch (e) { $('dChangeList').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
$('vDash').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.cancel) { if (!confirm('Cancel this booking?')) return; await api('/api/bookings/' + d.cancel, 'DELETE'); }
    else if (d.read) await api(`/api/messages/${d.read}/read`, 'POST');
    else if (d.delmsg) { if (!confirm('Delete this message?')) return; await api('/api/messages/' + d.delmsg, 'DELETE'); }
    else if (d.reply) { const t = prompt('Your reply:'); if (!t) return; await api(`/api/messages/${d.reply}/reply`, 'POST', { text: t }); }
    else return;
    loadDash();
  } catch (err) { alert(err.message); }
});

// ---------- rep: message the admin ----------
async function loadMsgs() {
  try {
    const ms = await api('/api/messages');
    $('msgList').innerHTML = ms.length ? ms.map((m) => `<div class="item"><div class="l1"><small>${when(m.created)}</small></div><div class="l2">${esc(m.body)}</div>${m.reply ? `<div class="reply"><b>Admin:</b> ${esc(m.reply)}</div>` : '<small>Waiting for a reply</small>'}</div>`).join('')
      : '<div class="empty">No messages yet.</div>';
  } catch (e) { $('msgList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$('msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/messages', 'POST', { body: $('msgBody').value }); $('msgForm').reset(); say('msgMsg', 'Sent to the admin.', true); loadMsgs(); }
  catch (err) { say('msgMsg', err.message); }
});

// ---------- account ----------
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/password', 'POST', { current: $('pc').value, next: $('pn').value }); $('pwForm').reset(); say('pwMsg', 'Password updated.', true); }
  catch (err) { say('pwMsg', err.message); }
});

// ---------- start ----------
(async () => {
  $('group').innerHTML = '<option value="">All halls</option>' + ['SWLT', 'NLT', 'LT', 'CALC'].map((g) => `<option>${g}</option>`).join('');
  try { me = await api('/api/me'); showApp(); } catch (e) { showLogin(); }
})();
