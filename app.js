const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toM = (t) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let me = null, data = { halls: [], classes: [], bookings: [] }, tab = 'free', openHall = null, view = 'vFind';

async function api(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please sign in again.'); }
  if (!res.ok) { const err = new Error(j.error || 'Request failed.'); err.details = j.details; throw err; }
  return j;
}
const say = (id, text, ok) => { const el = $(id); el.textContent = text; el.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : ''); };

// ---------- login / shell ----------
function showLogin() { me = null; $('appView').hidden = true; $('loginView').hidden = false; $('lp').value = ''; }
function showApp() {
  $('loginView').hidden = true; $('appView').hidden = false;
  $('who').textContent = `${me.name}${me.programme ? ' · ' + me.programme : ''}`;
  const tabs = [['vFind', 'Find a hall'], ['vMine', me.role === 'admin' ? 'All bookings' : 'My bookings']];
  if (me.role === 'admin') tabs.push(['vAdmin', 'Manage']);
  tabs.push(['vAccount', 'Account']);
  $('nav').innerHTML = tabs.map(([id, t]) => `<button data-v="${id}" class="${id === view ? 'on' : ''}">${t}</button>`).join('');
  go(view);
}
function go(v) {
  view = v;
  ['vFind', 'vMine', 'vAdmin', 'vAccount'].forEach((id) => ($(id).hidden = id !== v));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'vFind') load(); if (v === 'vMine') loadMine(); if (v === 'vAdmin') loadAdmin();
}
$('nav').addEventListener('click', (e) => { if (e.target.dataset.v) go(e.target.dataset.v); });
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); say('loginMsg', '');
  try { me = await api('/api/login', 'POST', { username: $('lu').value, password: $('lp').value }); view = 'vFind'; showApp(); }
  catch (err) { say('loginMsg', err.message); }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', 'POST', {}); } catch (e) {} showLogin(); });

// ---------- finder ----------
function setNow() { const n = new Date(); $('date').value = localDate(n); $('time').value = hhmm(n.getHours() * 60 + n.getMinutes()); load(); }
async function load() {
  if (!$('date').value) return setNow();
  try { data = await api('/api/day?date=' + $('date').value); render(); } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function status(h, m) {
  const items = [
    ...data.classes.filter((c) => c.hall_id === h.id && !c.released).map((c) => ({ s: c.start_min, e: c.end_min, label: c.course, short: c.course })),
    ...data.bookings.filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, label: `Booked by ${b.by_name}`, short: `Booked by ${b.by_name}` })),
  ].sort((a, b) => a.s - b.s);
  const now = items.find((x) => x.s <= m && m < x.e);
  if (now) return { free: false, until: now.e, short: now.short };
  const next = items.find((x) => x.s > m);
  return { free: true, until: next ? next.s : null };
}
function render() {
  const m = toM($('time').value), grp = $('group').value, minSeats = +$('seats').value || 0, dur = +$('dur').value;
  const q = $('q').value.toLowerCase().replace(/\s+/g, '');
  let rows = data.halls.filter((h) => (!grp || h.grp === grp) && h.seats >= minSeats && (!q || h.name.toLowerCase().replace(/\s+/g, '').includes(q)))
    .map((h) => ({ h, s: status(h, m) }));
  rows = rows.filter((x) => !x.s.free || !dur || x.s.until === null || x.s.until - m >= dur);
  const nFree = rows.filter((x) => x.s.free).length;
  const shown = rows.filter((x) => (tab === 'all' ? true : tab === 'free' ? x.s.free : !x.s.free))
    .sort((a, b) => b.s.free - a.s.free || (b.s.until ?? 1e9) - (a.s.until ?? 1e9));
  const d = new Date($('date').value + 'T00:00:00');
  $('summary').textContent = `${nFree} free, ${rows.length - nFree} in use · ${DAYNAMES[d.getDay()]} ${$('date').value} at ${hhmm(m)}`;
  $('list').innerHTML = shown.length ? shown.map(({ h, s }) => `
    <div class="hall ${s.free ? '' : 'busy'}" data-id="${h.id}" tabindex="0" role="button" aria-expanded="${openHall === h.id}">
      <div class="top"><div><div class="name">${esc(h.name)}</div><div class="muted">${h.seats ? h.seats + ' seats' : 'Seats not set'}</div></div>
      <div class="badge ${s.free ? 'free' : 'taken'}">${s.free ? (s.until ? 'Free until ' + hhmm(s.until) : 'Free for the rest of the day') : esc(s.short) + ' until ' + hhmm(s.until)}</div></div>
      ${openHall === h.id ? detail(h, s, m) : ''}
    </div>`).join('') : '<div class="empty">No halls match. Try another time, switch tabs, or loosen the filters.</div>';
}
function detail(h, s, m) {
  const date = $('date').value, today = localDate(), future = date >= today;
  const rep = (c) => me.role === 'admin' || (me.programme && c.programme.trim().toLowerCase() === me.programme.trim().toLowerCase());
  const lines = [
    ...data.classes.filter((c) => c.hall_id === h.id).map((c) => ({ s: c.start_min, e: c.end_min, html: c.released
        ? `<s>${esc(c.course)}</s> · online, hall free` : `${esc(c.course)}${c.programme ? ' · ' + esc(c.programme) : ''}`,
      btn: future && rep(c) ? `<button class="small" data-act="${c.released ? 'restore' : 'release'}" data-id="${c.id}">${c.released ? 'Undo' : 'Class is online'}</button>` : '' })),
    ...data.bookings.filter((b) => b.hall_id === h.id).map((b) => ({ s: b.start_min, e: b.end_min, html: `Booked by ${esc(b.by_name)} · ${esc(b.purpose)}`,
      btn: b.user_id === me.id || me.role === 'admin' ? `<button class="small" data-act="cancel" data-id="${b.id}">Cancel</button>` : '' })),
  ].sort((a, b) => a.s - b.s);
  const from = s.free ? m : s.until, to = s.free ? Math.min(m + 60, s.until ?? m + 60) : s.until + 60;
  return `<div class="detail">
    ${lines.length ? lines.map((l) => `<div class="ln"><span>${hhmm(l.s)}–${hhmm(l.e)} · ${l.html}</span>${l.btn}</div>`).join('') : '<div class="muted">No classes or bookings on this date.</div>'}
    <div class="bk">
      <input class="wide" id="bkPurpose" placeholder="Purpose (e.g. CSC 205 group study)" maxlength="80" style="grid-column:1/-1">
      <input type="time" id="bkFrom" value="${hhmm(Math.min(from, 1439))}"><input type="time" id="bkTo" value="${hhmm(Math.min(to, 1439))}">
      <button class="primary" data-act="book" data-id="${h.id}" style="grid-column:1/-1">Book this hall</button>
      <p class="msg" id="bkMsg" style="grid-column:1/-1"></p>
    </div></div>`;
}
$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { act, id } = btn.dataset, date = $('date').value;
    try {
      if (act === 'release') await api('/api/releases', 'POST', { class_id: +id, date });
      else if (act === 'restore') await api('/api/releases', 'DELETE', { class_id: +id, date });
      else if (act === 'cancel') await api('/api/bookings/' + id, 'DELETE');
      else if (act === 'book') await api('/api/bookings', 'POST', { hall_id: +id, date, start: $('bkFrom').value, end: $('bkTo').value, purpose: $('bkPurpose').value });
      await load();
    } catch (err) { if ($('bkMsg')) say('bkMsg', err.message); else alert(err.message); }
    return;
  }
  if (e.target.closest('.detail')) return;
  const el = e.target.closest('.hall'); if (!el) return;
  openHall = openHall === +el.dataset.id ? null : +el.dataset.id; render();
});
$('list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('hall')) { e.preventDefault(); e.target.click(); } });
['date', 'time'].forEach((id) => $(id).addEventListener('change', load));
['group', 'seats', 'dur', 'q'].forEach((id) => $(id).addEventListener('input', render));
$('now').addEventListener('click', setNow);
[['tFree', 'free'], ['tBusy', 'busy'], ['tAll', 'all']].forEach(([id, v]) => $(id).addEventListener('click', () => {
  tab = v; ['tFree', 'tBusy', 'tAll'].forEach((x) => $(x).classList.toggle('on', x === id)); render();
}));

// ---------- bookings list ----------
async function loadMine() {
  try {
    const rows = await api('/api/bookings');
    $('mine').innerHTML = rows.length ? `<table><tr><th>Date</th><th>Time</th><th>Hall</th><th>Purpose</th>${me.role === 'admin' ? '<th>By</th>' : ''}<th></th></tr>` +
      rows.map((r) => `<tr><td>${r.date}</td><td>${hhmm(r.start_min)}–${hhmm(r.end_min)}</td><td>${esc(r.hall)}</td><td>${esc(r.purpose)}</td>${me.role === 'admin' ? `<td>${esc(r.by_name)}</td>` : ''}<td><button class="small" data-cancel="${r.id}">Cancel</button></td></tr>`).join('') + '</table>'
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
      <td><button class="small" data-pw="${u.id}">Reset password</button> ${u.id === me.id ? '' : `<button class="small" data-del="${u.id}">Delete</button>`}</td></tr>`).join('') + '</table>';
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
