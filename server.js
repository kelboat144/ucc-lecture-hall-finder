const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { importTimetable } = require('./timetable');

const app = express();
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const SESSION_MS = 365 * 24 * 3600 * 1000;      // no inactivity logout: a session ends only by logout, new login, password change or revoke
const LOCK_MS = 258 * 1000;                      // 3 wrong passwords = 258 seconds
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const parseTime = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim()); if (!m) return null; const v = +m[1] * 60 + +m[2]; return +m[1] < 24 && +m[2] < 60 ? v : null; };
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const nowParts = () => { const n = new Date(); return { date: n.toISOString().slice(0, 10), min: n.getUTCHours() * 60 + n.getUTCMinutes() }; }; // Ghana = UTC+0
const inPast = (date, endMin) => { const n = nowParts(); return date < n.date || (date === n.date && endMin <= n.min); };
const fail = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

// ---------- roles and permissions ----------
const RANK = { super: 4, main: 3, delegated: 2, pr: 1 };
const PERM_KEYS = ['bookings.view', 'bookings.decide', 'bookings.cancel', 'halls.manage', 'messages.handle'];
const permsOf = (u) => (u.role === 'delegated' ? all('SELECT perm FROM permissions WHERE user_id=? AND (expires IS NULL OR expires>?)', u.id, Date.now()).map((r) => r.perm) : []);
const can = (u, key) => u.role === 'super' || u.role === 'main' || (u.role === 'delegated' && permsOf(u).includes(key));

// ---------- audit + notifications ----------
function audit(actor, module, action, target, reason, before, after, severity = 'info') {
  run('INSERT INTO audit_log (actor_id,actor_name,actor_role,module,action,target,reason,before,after,severity,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    actor ? actor.id : null, actor ? actor.name : 'System', actor ? actor.role : 'system', module, action, target || '', reason || '',
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, severity, Date.now());
}
function notify(userId, cat, title, body = '', link = '') {
  if (cat !== 'security') { const p = one('SELECT enabled FROM notif_prefs WHERE user_id=? AND category=?', userId, cat); if (p && !p.enabled) return; }
  run('INSERT INTO notifications (user_id,category,title,body,link,created) VALUES (?,?,?,?,?,?)', userId, cat, title, body, link, Date.now());
}
const superIds = () => all("SELECT id FROM users WHERE role='super' AND status='active'").map((r) => r.id);
function deciderIds() {
  const ids = all(`SELECT id FROM users WHERE status='active' AND (role='main' OR (role='delegated' AND EXISTS
    (SELECT 1 FROM permissions p WHERE p.user_id=users.id AND p.perm='bookings.decide' AND (p.expires IS NULL OR p.expires>?))))`, Date.now()).map((r) => r.id);
  return ids.length ? ids : superIds();
}
const handlerIds = () => {
  const ids = all(`SELECT id FROM users WHERE status='active' AND (role='main' OR (role='delegated' AND EXISTS
    (SELECT 1 FROM permissions p WHERE p.user_id=users.id AND p.perm='messages.handle' AND (p.expires IS NULL OR p.expires>?))))`, Date.now()).map((r) => r.id);
  return ids.length ? ids : superIds();
};

// ---------- first Super Admin ----------
if (!one("SELECT id FROM users WHERE role='super'")) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  run("INSERT INTO users (username,name,password_hash,role,created) VALUES (?,?,?, 'super', ?)", username, 'Super Admin', bcrypt.hashSync(pw, 11), Date.now());
  console.log(`\nSuper Admin account created. Username: ${username}` + (process.env.ADMIN_PASSWORD ? '' : `  Password: ${pw}`) + '\n');
}
require('./bootstrap')(bcrypt);

// ---------- sessions ----------
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const cookieOpts = () => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` + (PROD ? '; Secure' : '');
const device = (req) => { const ua = req.headers['user-agent'] || ''; const o = /(Android|iPhone|iPad|Windows|Mac OS X|Linux)/.exec(ua), b = /(Edg|Chrome|Firefox|Safari)/.exec(ua); return `${b ? b[1] : 'Browser'} on ${o ? o[1] : 'unknown device'} (${req.ip})`; };

app.use((req, res, next) => {
  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
  if (req.method !== 'GET' && hasBody && !req.is('json')) return fail(res, 415, 'JSON requests only.');
  const tok = cookies(req).sid;
  if (tok) {
    const u = one(`SELECT u.id,u.username,u.name,u.role,u.programme,u.level,u.status,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?`, tok, Date.now());
    if (u && u.status === 'active') { req.user = u; req.token = tok; }
  }
  next();
});
const needUser = (req, res, next) => {
  if (!req.user) return fail(res, 401, 'Please sign in. If you were signed in, your account may have been opened on another device.');
  if (req.user.must_change && !['/api/me', '/api/password', '/api/logout'].includes(req.path)) return fail(res, 403, 'Change your temporary password first.', { must_change: true });
  next();
};
const needRole = (...roles) => (req, res, next) => (req.user && roles.includes(req.user.role) ? next() : fail(res, 403, 'You do not have access to this.'));
const needPerm = (key) => (req, res, next) => (req.user && can(req.user, key) ? next() : fail(res, 403, 'You have not been given permission for this.'));
const staff = needRole('super', 'main', 'delegated');

// ---------- login: username only, 3 wrong passwords = 258 s lock, one active session ----------
const ipFails = new Map();
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, programme: u.programme, level: u.level, must_change: u.must_change, perms: permsOf(u) });
app.post('/api/login', (req, res) => {
  const a = ipFails.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 30) return fail(res, 429, 'Too many attempts from this device. Try again in 15 minutes.');
  const { username = '', password = '' } = req.body || {};
  const u = one('SELECT * FROM users WHERE username=?', clean(username, 40));
  if (!u) { a.n++; ipFails.set(req.ip, a); return fail(res, 401, 'Incorrect username or password.'); }
  if (u.locked_until > Date.now()) return fail(res, 423, 'This account is temporarily locked.', { retry_after: Math.ceil((u.locked_until - Date.now()) / 1000) });
  if (!bcrypt.compareSync(String(password), u.password_hash)) {
    a.n++; ipFails.set(req.ip, a);
    const failed = u.failed + 1;
    if (failed >= 3) {
      run('UPDATE users SET failed=0, locked_until=? WHERE id=?', Date.now() + LOCK_MS, u.id);
      audit(null, 'security', 'account_locked', u.username, 'Three consecutive wrong passwords', null, { seconds: 258, device: device(req) }, 'warning');
      superIds().forEach((id) => notify(id, 'security', 'Account locked', `${u.name} (${u.username}) entered a wrong password 3 times and is locked for 4 min 18 s.`, 'audit'));
      return fail(res, 423, 'Too many wrong passwords. The account is locked.', { retry_after: 258 });
    }
    run('UPDATE users SET failed=? WHERE id=?', failed, u.id);
    return fail(res, 401, failed === 2 ? 'Incorrect username or password. One attempt remains before the account locks.' : 'Incorrect username or password.');
  }
  if (u.status !== 'active') {
    const why = { suspended: 'suspended', frozen: 'frozen while it is reviewed', archived: 'deactivated' }[u.status];
    return fail(res, 403, `This account is ${why}. Contact your administrator.`);
  }
  run('UPDATE users SET failed=0, locked_until=0 WHERE id=?', u.id);
  ipFails.delete(req.ip);
  const prev = one('SELECT token FROM sessions WHERE user_id=?', u.id);
  run('DELETE FROM sessions WHERE user_id=?', u.id);
  run('DELETE FROM sessions WHERE expires<?', Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  const dev = device(req);
  run('INSERT INTO sessions (token,user_id,expires,device) VALUES (?,?,?,?)', token, u.id, Date.now() + SESSION_MS, dev);
  audit(u, 'security', prev ? 'login_replaced_session' : 'login', u.username, '', null, { device: dev });
  if (prev) notify(u.id, 'security', 'New sign-in on your account', `Signed in on ${dev}. Your previous session was ended. If this was not you, contact your administrator.`, '');
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieOpts()}`);
  res.json(publicUser(u));
});
app.post('/api/logout', (req, res) => {
  if (req.token) run('DELETE FROM sessions WHERE token=?', req.token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', needUser, (req, res) => res.json({ ...publicUser(req.user), unread: one('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND is_read=0', req.user.id).n }));
app.post('/api/password', needUser, (req, res) => {
  const { current = '', next = '' } = req.body || {};
  const u = one('SELECT * FROM users WHERE id=?', req.user.id);
  if (!bcrypt.compareSync(String(current), u.password_hash)) return fail(res, 400, 'Current password is incorrect.');
  if (String(next).length < 6) return fail(res, 400, 'Use at least 6 characters.');
  if (String(next) === String(current)) return fail(res, 400, 'Choose a different password from the temporary one.');
  run('UPDATE users SET password_hash=?, must_change=0 WHERE id=?', bcrypt.hashSync(String(next), 11), u.id);
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', u.id, req.token);
  audit(u, 'security', 'password_changed', u.username, '');
  notify(u.id, 'security', 'Password changed', 'Your password was changed and other sessions were ended.');
  res.json({ ok: true });
});

// ---------- notifications ----------
const CATS = ['bookings', 'halls', 'timetables', 'messages'];
app.get('/api/notifications', needUser, (req, res) => res.json(all('SELECT * FROM notifications WHERE user_id=? ORDER BY created DESC LIMIT 100', req.user.id)));
app.post('/api/notifications/read', needUser, (req, res) => {
  const id = (req.body || {}).id;
  if (id) run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', id, req.user.id); else run('UPDATE notifications SET is_read=1 WHERE user_id=?', req.user.id);
  res.json({ ok: true });
});
app.get('/api/notif-prefs', needUser, (req, res) => {
  const p = Object.fromEntries(all('SELECT category,enabled FROM notif_prefs WHERE user_id=?', req.user.id).map((r) => [r.category, r.enabled]));
  res.json(CATS.map((c) => ({ category: c, enabled: p[c] === undefined ? 1 : p[c] })));
});
app.put('/api/notif-prefs', needUser, (req, res) => {
  const { category, enabled } = req.body || {};
  if (!CATS.includes(category)) return fail(res, 400, 'Security alerts cannot be turned off.');
  run('INSERT INTO notif_prefs (user_id,category,enabled) VALUES (?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET enabled=excluded.enabled', req.user.id, category, enabled ? 1 : 0);
  res.json({ ok: true });
});

// ---------- availability ----------
app.get('/api/day', needUser, (req, res) => {
  const date = String(req.query.date || '');
  if (!validDate(date)) return fail(res, 400, 'Invalid date.');
  res.json({
    halls: all('SELECT id,name,grp,seats FROM halls ORDER BY grp, CAST(SUBSTR(name, INSTR(name,\' \')+1) AS INTEGER)'),
    classes: all(`SELECT c.id,c.hall_id,c.start_min,c.end_min,c.course,c.programme, r.kind, r.new_date, r.new_start, r.new_end,
        (r.class_id IS NOT NULL) AS released
        FROM classes c LEFT JOIN releases r ON r.class_id=c.id AND r.date=? WHERE c.day=? ORDER BY c.start_min`, date, dow(date)),
    moved: all(`SELECT c.id,c.hall_id,r.new_start AS start_min,r.new_end AS end_min,c.course,c.programme,r.date AS from_date
        FROM releases r JOIN classes c ON c.id=r.class_id WHERE r.kind='postponed' AND r.new_date=?`, date),
    bookings: all(`SELECT b.id,b.hall_id,b.start_min,b.end_min,b.purpose,b.user_id,u.name AS by_name
        FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.date=? AND b.status='approved' ORDER BY b.start_min`, date),
    pending: all(`SELECT b.id,b.hall_id,b.start_min,b.end_min,b.purpose,b.user_id,b.status,u.name AS by_name
        FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.date=? AND b.status IN ('pending','alternative') ORDER BY b.start_min`, date),
  });
});

// Only approved bookings occupy a hall. Pending requests never block anyone.
function clash(hallId, date, s, e, skipClass = 0, skipBooking = 0) {
  const c = one(`SELECT course FROM classes c WHERE hall_id=? AND day=? AND start_min<? AND end_min>?
      AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.class_id=c.id AND r.date=?)`, hallId, dow(date), e, s, date);
  if (c) return `The hall is in use for ${c.course} during that time.`;
  const b = one("SELECT start_min,end_min FROM bookings WHERE hall_id=? AND date=? AND status='approved' AND id<>? AND start_min<? AND end_min>?", hallId, date, skipBooking, e, s);
  if (b) return `The hall is already booked ${fmt(b.start_min)}–${fmt(b.end_min)}.`;
  const m = one(`SELECT c.course FROM releases r JOIN classes c ON c.id=r.class_id
      WHERE r.kind='postponed' AND r.new_date=? AND c.hall_id=? AND r.new_start<? AND r.new_end>? AND r.class_id<>?`, date, hallId, e, s, skipClass);
  if (m) return `A postponed class (${m.course}) is scheduled then.`;
  return null;
}
const hallName = (id) => (one('SELECT name FROM halls WHERE id=?', id) || {}).name || '?';
const hallByName = (n) => one('SELECT id,name FROM halls WHERE REPLACE(LOWER(name),\' \',\'\')=?', String(n).toLowerCase().replace(/\s+/g, ''));
const slotText = (b) => `${hallName(b.hall_id)} on ${b.date}, ${fmt(b.start_min)}–${fmt(b.end_min)}`;

// ---------- bookings: request -> pending -> approve / reject / suggest alternative ----------
app.post('/api/bookings', needUser, needRole('pr'), (req, res) => {
  const { hall_id, date, start, end, purpose = '' } = req.body || {};
  const s = parseTime(start), e = parseTime(end);
  if (!one('SELECT id FROM halls WHERE id=?', hall_id)) return fail(res, 400, 'Unknown hall.');
  if (!validDate(String(date)) || s === null || e === null) return fail(res, 400, 'Enter a valid date and times.');
  if (e <= s) return fail(res, 400, 'End time must be after the start time.');
  if (inPast(date, e)) return fail(res, 400, 'That time has already passed.');
  const p = clean(purpose, 80);
  if (!p) return fail(res, 400, 'Enter the purpose of the booking.');
  const err = clash(hall_id, date, s, e);
  if (err) return fail(res, 409, err);
  if (one("SELECT id FROM bookings WHERE user_id=? AND hall_id=? AND date=? AND status IN ('pending','alternative','approved') AND start_min<? AND end_min>?", req.user.id, hall_id, date, e, s))
    return fail(res, 409, 'You already have an overlapping request for this hall.');
  const r = run("INSERT INTO bookings (hall_id,date,start_min,end_min,purpose,user_id,created,status) VALUES (?,?,?,?,?,?,?, 'pending')", hall_id, date, s, e, p, req.user.id, Date.now());
  const id = Number(r.lastInsertRowid);
  audit(req.user, 'bookings', 'requested', `booking #${id}`, p, null, { hall: hallName(hall_id), date, start: fmt(s), end: fmt(e) });
  deciderIds().forEach((uid) => notify(uid, 'bookings', 'New booking request', `${req.user.name} requested ${hallName(hall_id)} on ${date}, ${fmt(s)}–${fmt(e)}.`, 'dash'));
  res.json({ id, status: 'pending' });
});
app.get('/api/bookings', needUser, (req, res) => {
  const n = nowParts();
  const sel = `SELECT b.id,b.hall_id,b.date,b.start_min,b.end_min,b.purpose,b.status,b.decision_reason,b.cancel_req,b.created,b.user_id,
      b.alt_hall,b.alt_date,b.alt_start,b.alt_end,h.name AS hall,u.name AS by_name,u.programme,ah.name AS alt_hall_name
      FROM bookings b JOIN halls h ON h.id=b.hall_id JOIN users u ON u.id=b.user_id LEFT JOIN halls ah ON ah.id=b.alt_hall
      WHERE (b.date>? OR (b.date=? AND b.end_min>?))`;
  if (req.user.role === 'pr') return res.json(all(sel + ' AND b.user_id=? ORDER BY b.date,b.start_min', n.date, n.date, n.min, req.user.id));
  if (!can(req.user, 'bookings.view') && !can(req.user, 'bookings.decide')) return fail(res, 403, 'You have not been given permission for this.');
  res.json(all(sel + " AND b.status IN ('pending','alternative','approved') ORDER BY b.date,b.start_min", n.date, n.date, n.min));
});
app.post('/api/bookings/:id/decision', needUser, staff, needPerm('bookings.decide'), (req, res) => {
  const { decision, reason, alt } = req.body || {};
  const why = clean(reason, 300);
  if (!why) return fail(res, 400, 'A reason is required for every decision.');
  try {
    const out = db.transaction(() => {
      const b = one('SELECT * FROM bookings WHERE id=?', req.params.id);
      if (!b || b.status !== 'pending') throw Object.assign(new Error('This request is no longer pending.'), { code: 409 });
      if (decision === 'approve') {
        const err = clash(b.hall_id, b.date, b.start_min, b.end_min, 0, b.id);
        if (err) throw Object.assign(new Error(err + ' Reject it or suggest another slot.'), { code: 409 });
        run("UPDATE bookings SET status='approved', decided_by=?, decided_at=?, decision_reason=? WHERE id=?", req.user.id, Date.now(), why, b.id);
      } else if (decision === 'reject') {
        run("UPDATE bookings SET status='rejected', decided_by=?, decided_at=?, decision_reason=? WHERE id=?", req.user.id, Date.now(), why, b.id);
      } else if (decision === 'alternative') {
        const h = hallByName((alt || {}).hall), s = parseTime((alt || {}).start), e = parseTime((alt || {}).end);
        if (!h || !validDate(String((alt || {}).date)) || s === null || e === null || e <= s) throw Object.assign(new Error('Enter a valid hall, date and times for the alternative.'), { code: 400 });
        if (inPast(alt.date, e)) throw Object.assign(new Error('The alternative time has already passed.'), { code: 400 });
        const err = clash(h.id, alt.date, s, e, 0, b.id);
        if (err) throw Object.assign(new Error('The alternative is not available. ' + err), { code: 409 });
        run("UPDATE bookings SET status='alternative', alt_hall=?, alt_date=?, alt_start=?, alt_end=?, decided_by=?, decided_at=?, decision_reason=? WHERE id=?", h.id, alt.date, s, e, req.user.id, Date.now(), why, b.id);
      } else throw Object.assign(new Error('Choose approve, reject or alternative.'), { code: 400 });
      audit(req.user, 'bookings', decision, `booking #${b.id}`, why, { status: 'pending', slot: slotText(b) }, alt ? { alternative: alt } : { status: decision });
      return b;
    })();
    const text = { approve: 'was approved', reject: 'was rejected', alternative: 'has an alternative proposed. Open My bookings to accept or decline it' }[decision];
    notify(out.user_id, 'bookings', 'Booking update', `Your request for ${slotText(out)} ${text}. Reason: ${why}`, 'mine');
    res.json({ ok: true });
  } catch (e) { return fail(res, e.code || 500, e.code ? e.message : 'Something went wrong. Please try again.'); }
});
app.post('/api/bookings/:id/respond', needUser, needRole('pr'), (req, res) => {
  const accept = !!(req.body || {}).accept;
  try {
    const b = db.transaction(() => {
      const b = one("SELECT * FROM bookings WHERE id=? AND user_id=? AND status='alternative'", req.params.id, req.user.id);
      if (!b) throw Object.assign(new Error('There is no alternative waiting for you.'), { code: 404 });
      if (accept) {
        const err = clash(b.alt_hall, b.alt_date, b.alt_start, b.alt_end, 0, b.id);   // re-check before booking
        if (err) throw Object.assign(new Error('The alternative is no longer available. ' + err), { code: 409 });
        run("UPDATE bookings SET hall_id=alt_hall, date=alt_date, start_min=alt_start, end_min=alt_end, status='approved', alt_hall=NULL, alt_date=NULL, alt_start=NULL, alt_end=NULL, decision_reason=? WHERE id=?", 'Alternative accepted by the representative', b.id);
      } else run("UPDATE bookings SET status='cancelled', decision_reason=? WHERE id=?", 'Alternative declined by the representative', b.id);
      audit(req.user, 'bookings', accept ? 'alternative_accepted' : 'alternative_declined', `booking #${b.id}`, '');
      return b;
    })();
    deciderIds().forEach((uid) => notify(uid, 'bookings', 'Alternative ' + (accept ? 'accepted' : 'declined'), `${req.user.name} ${accept ? 'accepted' : 'declined'} the alternative for booking #${b.id}.`, 'dash'));
    res.json({ ok: true });
  } catch (e) { return fail(res, e.code || 500, e.code ? e.message : 'Something went wrong. Please try again.'); }
});
app.post('/api/bookings/:id/cancel', needUser, (req, res) => {
  const why = clean((req.body || {}).reason, 300);
  const b = one('SELECT * FROM bookings WHERE id=?', req.params.id);
  if (!b || !['pending', 'alternative', 'approved'].includes(b.status)) return fail(res, 404, 'Booking not found.');
  if (req.user.role === 'pr') {
    if (b.user_id !== req.user.id) return fail(res, 403, 'You can only cancel your own bookings.');
    if (b.status !== 'approved') {                      // withdrawing a request that is not yet approved
      run("UPDATE bookings SET status='cancelled', decision_reason=? WHERE id=?", why || 'Withdrawn by the representative', b.id);
      audit(req.user, 'bookings', 'withdrawn', `booking #${b.id}`, why);
      return res.json({ ok: true, status: 'cancelled' });
    }
    if (!why) return fail(res, 400, 'Give a reason for the cancellation request.');
    run('UPDATE bookings SET cancel_req=? WHERE id=?', why, b.id);                   // approved: the admin decides
    audit(req.user, 'bookings', 'cancellation_requested', `booking #${b.id}`, why);
    deciderIds().forEach((uid) => notify(uid, 'bookings', 'Cancellation requested', `${req.user.name} asks to cancel ${slotText(b)}. Reason: ${why}`, 'dash'));
    return res.json({ ok: true, status: 'cancel_requested' });
  }
  if (!can(req.user, 'bookings.cancel')) return fail(res, 403, 'You have not been given permission for this.');
  if (!why) return fail(res, 400, 'A reason is required to cancel a booking.');
  run("UPDATE bookings SET status='cancelled', decided_by=?, decided_at=?, decision_reason=?, cancel_req=NULL WHERE id=?", req.user.id, Date.now(), why, b.id);
  audit(req.user, 'bookings', 'cancelled', `booking #${b.id}`, why, { status: b.status, slot: slotText(b) }, { status: 'cancelled' });
  notify(b.user_id, 'bookings', 'Booking cancelled', `${slotText(b)} was cancelled. Reason: ${why}`, 'mine');
  res.json({ ok: true, status: 'cancelled' });
});

// ---------- classes moved online / cancelled / postponed ----------
const canRelease = (user, c) => user.role === 'super' || user.role === 'main' || (user.role === 'pr' && user.programme && c.programme.trim().toLowerCase() === user.programme.trim().toLowerCase());
app.post('/api/releases', needUser, (req, res) => {
  const { class_id, date, kind = 'online', new_date, new_start, new_end } = req.body || {};
  const c = one('SELECT * FROM classes WHERE id=?', class_id);
  if (!c || !validDate(String(date)) || dow(date) !== c.day) return fail(res, 400, 'That class does not meet on this date.');
  if (!['online', 'cancelled', 'postponed'].includes(kind)) return fail(res, 400, 'Invalid change type.');
  if (!canRelease(req.user, c)) return fail(res, 403, 'You can only change classes for your own programme.');
  if (inPast(date, c.end_min)) return fail(res, 400, 'That class has already ended.');
  let nd = null, ns = null, ne = null;
  if (kind === 'postponed') {
    nd = String(new_date || ''); ns = parseTime(new_start); ne = parseTime(new_end);
    if (!validDate(nd) || ns === null || ne === null || ne <= ns) return fail(res, 400, 'Enter a valid new date and time.');
    if (inPast(nd, ne)) return fail(res, 400, 'The new time has already passed.');
    if (nd === date && ns === c.start_min && ne === c.end_min) return fail(res, 400, 'The new time is the same as the original.');
  }
  try {
    db.transaction(() => {
      run('INSERT OR REPLACE INTO releases (class_id,date,by_user,kind,new_date,new_start,new_end,created) VALUES (?,?,?,?,?,?,?,?)', c.id, date, req.user.id, kind, nd, ns, ne, Date.now());
      if (kind === 'postponed') { const err = clash(c.hall_id, nd, ns, ne, c.id); if (err) throw new Error(err); }
    })();
  } catch (e) { return fail(res, 409, e.message); }
  audit(req.user, 'classes', kind, `${c.course} on ${date}`, '', null, { hall: hallName(c.hall_id), new_date: nd });
  res.json({ ok: true });
});
app.delete('/api/releases', needUser, (req, res) => {
  const { class_id, date } = req.body || {};
  const c = one('SELECT * FROM classes WHERE id=?', class_id);
  if (!c) return fail(res, 404, 'Class not found.');
  if (!canRelease(req.user, c)) return fail(res, 403, 'You can only restore classes for your own programme.');
  if (clash(c.hall_id, date, c.start_min, c.end_min, c.id)) return fail(res, 409, 'The hall has been taken for this time, so the class cannot be restored.');
  run('DELETE FROM releases WHERE class_id=? AND date=?', c.id, date);
  audit(req.user, 'classes', 'restored', `${c.course} on ${date}`, '');
  res.json({ ok: true });
});

// ---------- user management (hierarchy enforced here, not just in the screens) ----------
const withPerms = (u) => ({ ...u, perms: permsOf(u) });
app.get('/api/users', needUser, needRole('super', 'main'), (req, res) => {
  const rows = all(`SELECT id,username,name,role,programme,level,status,status_reason,locked_until FROM users ${req.user.role === 'main' ? "WHERE role IN ('delegated','pr')" : ''} ORDER BY role, status, name`);
  res.json(rows.map(withPerms));
});
app.post('/api/users', needUser, needRole('super', 'main'), (req, res) => {
  const { username = '', name = '', password = '', role = 'pr', programme = '', level = null } = req.body || {};
  const allowed = req.user.role === 'super' ? ['main', 'delegated', 'pr'] : ['delegated'];   // Main Admin appoints Delegated Admins; Super Admin creates the rest
  if (!allowed.includes(role)) return fail(res, 403, `You cannot create a ${role} account.`);
  const u = clean(username, 30);
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(u)) return fail(res, 400, 'Username: 3–30 letters, numbers, dot, dash or underscore. It cannot be changed later.');
  if (!clean(name, 60)) return fail(res, 400, 'Enter the account name.');
  if (String(password).length < 6) return fail(res, 400, 'The temporary password needs at least 6 characters.');
  if (role === 'pr' && !clean(programme, 80)) return fail(res, 400, 'Enter the programme or class, e.g. BSc Computer Science L200.');
  if (one('SELECT id FROM users WHERE username=?', u)) return fail(res, 409, 'That username is taken, including by archived accounts.');
  const r = run('INSERT INTO users (username,name,password_hash,role,programme,level,must_change,created) VALUES (?,?,?,?,?,?,1,?)', u, clean(name, 60), bcrypt.hashSync(String(password), 11), role, clean(programme, 80), level ? +level : null, Date.now());
  audit(req.user, 'users', 'created', u, '', null, { role, programme });
  res.json({ id: Number(r.lastInsertRowid) });
});
function target(req, res, minActorRank) {                       // actor must outrank the target
  const t = one('SELECT * FROM users WHERE id=?', req.params.id);
  if (!t) { fail(res, 404, 'Account not found.'); return null; }
  if (t.id === req.user.id || RANK[req.user.role] <= RANK[t.role]) { fail(res, 403, 'You cannot do this to that account.'); return null; }
  return t;
}
app.post('/api/users/:id/reset', needUser, needRole('super', 'main'), (req, res) => {
  const t = target(req, res); if (!t) return;
  const pw = String((req.body || {}).password || ''), why = clean((req.body || {}).reason, 300);
  if (!why) return fail(res, 400, 'Confirm you verified the person, and say how (reason required).');
  if (pw.length < 6) return fail(res, 400, 'The temporary password needs at least 6 characters.');
  run('UPDATE users SET password_hash=?, must_change=1, failed=0, locked_until=0 WHERE id=?', bcrypt.hashSync(pw, 11), t.id);
  run('DELETE FROM sessions WHERE user_id=?', t.id);
  audit(req.user, 'security', 'password_reset', t.username, why, null, null, 'warning');
  res.json({ ok: true });
});
app.post('/api/users/:id/status', needUser, needRole('super', 'main'), (req, res) => {
  const t = target(req, res); if (!t) return;
  const { status, reason } = req.body || {}, why = clean(reason, 300);
  if (!['active', 'suspended', 'frozen'].includes(status)) return fail(res, 400, 'Invalid status.');
  if (status === 'frozen' && req.user.role !== 'super') return fail(res, 403, 'Only the Super Admin can freeze an account.');
  if (t.status === 'archived') return fail(res, 400, 'Deactivated accounts cannot be changed.');
  if (!why) return fail(res, 400, 'A reason is required.');
  if (status === 'active' && t.status_by_role && RANK[t.status_by_role] > RANK[req.user.role]) return fail(res, 403, 'A higher authority applied this. Only they can lift it.');
  run('UPDATE users SET status=?, status_reason=?, status_by_role=? WHERE id=?', status, why, req.user.role, t.id);
  if (status !== 'active') run('DELETE FROM sessions WHERE user_id=?', t.id);
  audit(req.user, 'users', status === 'active' ? 'reinstated' : status, t.username, why, { status: t.status }, { status }, status === 'active' ? 'info' : 'warning');
  res.json({ ok: true });
});
app.post('/api/users/:id/deactivate', needUser, needRole('super', 'main'), (req, res) => {   // archive: history is kept, nothing is erased
  const t = target(req, res); if (!t) return;
  const why = clean((req.body || {}).reason, 300);
  if (!why) return fail(res, 400, 'A reason is required.');
  run("UPDATE users SET status='archived', status_reason=?, status_by_role=? WHERE id=?", why, req.user.role, t.id);
  run('DELETE FROM sessions WHERE user_id=?', t.id);
  audit(req.user, 'users', 'deactivated', t.username, why, { status: t.status }, { status: 'archived' }, 'warning');
  res.json({ ok: true });
});
app.post('/api/users/:id/unlock', needUser, needRole('super', 'main'), (req, res) => {
  const t = target(req, res); if (!t) return;
  const why = clean((req.body || {}).reason, 300);
  if (!why) return fail(res, 400, 'Confirm you verified the person (reason required).');
  run('UPDATE users SET failed=0, locked_until=0 WHERE id=?', t.id);
  audit(req.user, 'security', 'unlocked', t.username, why, null, null, 'warning');
  res.json({ ok: true });
});
app.post('/api/users/:id/permissions', needUser, needRole('super', 'main'), (req, res) => {
  const t = target(req, res); if (!t) return;
  if (t.role !== 'delegated') return fail(res, 400, 'Permissions apply to Delegated Admins only.');
  const perms = ((req.body || {}).perms || []).filter((p) => PERM_KEYS.includes(p));
  const exp = (req.body || {}).expires, expires = exp ? Date.parse(exp + 'T23:59:59Z') : null;
  if (exp && (!validDate(exp) || expires < Date.now())) return fail(res, 400, 'Choose an expiry date in the future, or leave it empty.');
  const before = permsOf(t);
  db.transaction(() => {
    run('DELETE FROM permissions WHERE user_id=?', t.id);
    perms.forEach((p) => run('INSERT INTO permissions (user_id,perm,expires,granted_by) VALUES (?,?,?,?)', t.id, p, expires, req.user.id));
  })();
  audit(req.user, 'users', 'permissions_changed', t.username, clean((req.body || {}).reason, 300), { perms: before }, { perms, expires: exp || 'none' }, 'warning');
  res.json({ ok: true });
});

// ---------- halls and timetable ----------
app.patch('/api/halls/:id', needUser, staff, needPerm('halls.manage'), (req, res) => {
  const seats = Number((req.body || {}).seats);
  if (!Number.isInteger(seats) || seats < 0 || seats > 5000) return fail(res, 400, 'Enter a valid seat count.');
  const h = one('SELECT * FROM halls WHERE id=?', req.params.id);
  run('UPDATE halls SET seats=? WHERE id=?', seats, req.params.id);
  audit(req.user, 'halls', 'seats_changed', h ? h.name : '', '', { seats: h && h.seats }, { seats });
  res.json({ ok: true });
});
app.post('/api/timetable/import', needUser, needRole('super'), (req, res) => {   // only the Super Admin publishes the official timetable
  const body = req.body || {};
  const files = (Array.isArray(body.files) ? body.files : [{ name: 'file', csv: body.csv || '' }]).slice(0, 50);
  const r = importTimetable(files, body.replace !== false);
  if (r.errors.length) return res.status(400).json({ error: `${r.errors.length} problem(s) found. Nothing was imported.`, details: r.errors.slice(0, 20) });
  if (!r.imported && !r.skipped) return fail(res, 400, 'The files contain no timetable rows.');
  audit(req.user, 'timetables', body.replace !== false ? 'replaced' : 'appended', `${files.length} file(s)`, '', null, { imported: r.imported, skipped: r.skipped }, 'warning');
  res.json({ imported: r.imported, skipped: r.skipped, files: files.length });
});
app.get('/api/timetable/count', needUser, staff, (req, res) => res.json(one('SELECT COUNT(*) AS n FROM classes')));

// ---------- dashboard, messages ----------
app.get('/api/admin/overview', needUser, staff, (req, res) => {
  const changes = all(`SELECT r.date,r.kind,r.new_date,r.new_start,r.new_end,r.created,c.course,c.programme,c.start_min,c.end_min,h.name AS hall,u.name AS by_name
      FROM releases r JOIN classes c ON c.id=r.class_id JOIN halls h ON h.id=c.hall_id LEFT JOIN users u ON u.id=r.by_user
      WHERE r.date>=? ORDER BY r.date,c.start_min`, nowParts().date);
  res.json({ changes, unread: can(req.user, 'messages.handle') ? one('SELECT COUNT(*) AS n FROM messages WHERE is_read=0').n : 0 });
});
app.post('/api/messages', needUser, needRole('pr'), (req, res) => {
  const body = clean((req.body || {}).body, 500);
  if (!body) return fail(res, 400, 'Type a message first.');
  if (one('SELECT COUNT(*) AS n FROM messages WHERE user_id=? AND created>?', req.user.id, Date.now() - 3600000).n >= 10) return fail(res, 429, 'Too many messages. Try again later.');
  run('INSERT INTO messages (user_id,body,created) VALUES (?,?,?)', req.user.id, body, Date.now());
  handlerIds().forEach((id) => notify(id, 'messages', 'New message', `${req.user.name}: ${body.slice(0, 80)}`, 'dash'));
  res.json({ ok: true });
});
app.get('/api/messages', needUser, (req, res) => {
  const sel = 'SELECT m.id,m.body,m.created,m.is_read,m.reply,m.replied,u.name,u.programme FROM messages m JOIN users u ON u.id=m.user_id';
  if (req.user.role === 'pr') return res.json(all(sel + ' WHERE m.user_id=? ORDER BY m.created DESC LIMIT 50', req.user.id));
  if (!can(req.user, 'messages.handle')) return fail(res, 403, 'You have not been given permission for this.');
  res.json(all(sel + ' ORDER BY m.is_read ASC, m.created DESC LIMIT 200'));
});
app.post('/api/messages/:id/read', needUser, staff, needPerm('messages.handle'), (req, res) => { run('UPDATE messages SET is_read=1 WHERE id=?', req.params.id); res.json({ ok: true }); });
app.post('/api/messages/:id/reply', needUser, staff, needPerm('messages.handle'), (req, res) => {
  const text = clean((req.body || {}).text, 500);
  if (!text) return fail(res, 400, 'Type a reply first.');
  const m = one('SELECT user_id FROM messages WHERE id=?', req.params.id);
  run('UPDATE messages SET reply=?, replied=?, is_read=1 WHERE id=?', text, Date.now(), req.params.id);
  if (m) notify(m.user_id, 'messages', 'Reply from the admin', text.slice(0, 120), 'msg');
  res.json({ ok: true });
});

// ---------- audit log (read only; scope depends on role) ----------
app.get('/api/audit', needUser, staff, (req, res) => {
  const q = req.query, where = [], p = [];
  if (req.user.role === 'main') where.push("actor_role<>'super' AND module<>'reports'");
  if (req.user.role === 'delegated') {
    const mods = [...new Set(permsOf(req.user).map((k) => ({ bookings: 'bookings', halls: 'halls', messages: 'messages' }[k.split('.')[0]])).filter(Boolean))];
    where.push(`(actor_id=? OR module IN (${mods.map(() => '?').join(',') || "''"}))`); p.push(req.user.id, ...mods);
  }
  if (q.module) { where.push('module=?'); p.push(String(q.module)); }
  if (q.severity) { where.push('severity=?'); p.push(String(q.severity)); }
  if (q.actor) { where.push('actor_name LIKE ?'); p.push('%' + String(q.actor).slice(0, 40) + '%'); }
  if (q.action) { where.push('action LIKE ?'); p.push('%' + String(q.action).slice(0, 40) + '%'); }
  if (q.from && validDate(String(q.from))) { where.push('created>=?'); p.push(Date.parse(q.from + 'T00:00:00Z')); }
  res.json(all(`SELECT id,actor_name,actor_role,module,action,target,reason,before,after,severity,created FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, ...p));
});

// ---------- static ----------
const PUB = path.join(__dirname, 'public');
if (fs.existsSync(PUB)) app.use(express.static(PUB, { maxAge: PROD ? '1h' : 0 }));
else {
  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  ['app.js', 'style.css'].forEach((f) => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));
}
app.use((err, req, res, next) => { console.error(err); fail(res, 500, 'Something went wrong. Please try again.'); });
app.listen(PORT, () => console.log(`Lecture Hall Finder running on port ${PORT}`));
