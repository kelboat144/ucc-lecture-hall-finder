const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const SESSION_MS = 12 * 60 * 60 * 1000;
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
const nowParts = () => { const n = new Date(); return { date: n.toISOString().slice(0, 10), min: n.getUTCHours() * 60 + n.getUTCMinutes() }; }; // Ghana is UTC+0
const fail = (res, code, msg) => res.status(code).json({ error: msg });

// ---------- first admin ----------
if (!one("SELECT id FROM users WHERE role='admin'")) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  run("INSERT INTO users (username,name,password_hash,role) VALUES (?,?,?, 'admin')", username, 'Administrator', bcrypt.hashSync(pw, 11));
  console.log(`\nAdmin account created. Username: ${username}` + (process.env.ADMIN_PASSWORD ? '' : `  Password: ${pw}  (change it after first login)`) + '\n');
}

require('./bootstrap')(bcrypt);

// ---------- sessions ----------
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const cookieOpts = () => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` + (PROD ? '; Secure' : '');

app.use((req, res, next) => {
  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
  if (req.method !== 'GET' && hasBody && !req.is('json')) return fail(res, 415, 'JSON requests only.');
  const tok = cookies(req).sid;
  if (tok) {
    const u = one('SELECT u.id,u.username,u.name,u.role,u.programme FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', tok, Date.now());
    if (u) { req.user = u; req.token = tok; }
  }
  next();
});
const needUser = (req, res, next) => (req.user ? next() : fail(res, 401, 'Please log in.'));
const needAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : fail(res, 403, 'Administrators only.'));

// ---------- auth ----------
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const key = req.ip, a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
  const { username = '', password = '' } = req.body || {};
  const u = one('SELECT * FROM users WHERE username=?', String(username).trim());
  if (!u || !bcrypt.compareSync(String(password), u.password_hash)) {
    a.n++; attempts.set(key, a);
    return fail(res, 401, 'Incorrect username or password.');
  }
  attempts.delete(key);
  run('DELETE FROM sessions WHERE expires<?', Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions VALUES (?,?,?)', token, u.id, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieOpts()}`);
  res.json({ id: u.id, username: u.username, name: u.name, role: u.role, programme: u.programme });
});
app.post('/api/logout', (req, res) => {
  if (req.token) run('DELETE FROM sessions WHERE token=?', req.token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', needUser, (req, res) => res.json(req.user));
app.post('/api/password', needUser, (req, res) => {
  const { current = '', next = '' } = req.body || {};
  const u = one('SELECT * FROM users WHERE id=?', req.user.id);
  if (!bcrypt.compareSync(String(current), u.password_hash)) return fail(res, 400, 'Current password is incorrect.');
  if (String(next).length < 8) return fail(res, 400, 'New password must be at least 8 characters.');
  run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(String(next), 11), u.id);
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', u.id, req.token);
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
        FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.date=? ORDER BY b.start_min`, date),
  });
});

function clash(hallId, date, s, e, skipClass = 0) {
  const c = one(`SELECT course FROM classes c WHERE hall_id=? AND day=? AND start_min<? AND end_min>?
      AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.class_id=c.id AND r.date=?)`, hallId, dow(date), e, s, date);
  if (c) return `The hall is in use for ${c.course} during that time.`;
  const b = one('SELECT start_min,end_min FROM bookings WHERE hall_id=? AND date=? AND start_min<? AND end_min>?', hallId, date, e, s);
  if (b) return `The hall is already booked ${fmt(b.start_min)}–${fmt(b.end_min)}.`;
  const m = one(`SELECT c.course FROM releases r JOIN classes c ON c.id=r.class_id
      WHERE r.kind='postponed' AND r.new_date=? AND c.hall_id=? AND r.new_start<? AND r.new_end>? AND r.class_id<>?`, date, hallId, e, s, skipClass);
  if (m) return `A postponed class (${m.course}) is scheduled then.`;
  return null;
}
const inPast = (date, endMin) => { const n = nowParts(); return date < n.date || (date === n.date && endMin <= n.min); };

// ---------- bookings ----------
app.post('/api/bookings', needUser, (req, res) => {
  const { hall_id, date, start, end, purpose = '' } = req.body || {};
  const s = parseTime(start), e = parseTime(end);
  if (!one('SELECT id FROM halls WHERE id=?', hall_id)) return fail(res, 400, 'Unknown hall.');
  if (!validDate(String(date)) || s === null || e === null) return fail(res, 400, 'Enter a valid date and times.');
  if (e <= s) return fail(res, 400, 'End time must be after the start time.');
  if (inPast(date, e)) return fail(res, 400, 'That time has already passed.');
  const p = String(purpose).trim().slice(0, 80);
  if (!p) return fail(res, 400, 'Enter the purpose of the booking.');
  const err = clash(hall_id, date, s, e);
  if (err) return fail(res, 409, err);
  const r = run('INSERT INTO bookings (hall_id,date,start_min,end_min,purpose,user_id,created) VALUES (?,?,?,?,?,?,?)', hall_id, date, s, e, p, req.user.id, Date.now());
  res.json({ id: Number(r.lastInsertRowid) });
});
app.get('/api/bookings', needUser, (req, res) => {
  const n = nowParts();
  const rows = all(`SELECT b.id,b.date,b.start_min,b.end_min,b.purpose,h.name AS hall,u.name AS by_name
      FROM bookings b JOIN halls h ON h.id=b.hall_id JOIN users u ON u.id=b.user_id
      WHERE (b.date>? OR (b.date=? AND b.end_min>?)) AND (?='admin' OR b.user_id=?)
      ORDER BY b.date,b.start_min`, n.date, n.date, n.min, req.user.role, req.user.id);
  res.json(rows);
});
app.delete('/api/bookings/:id', needUser, (req, res) => {
  const b = one('SELECT * FROM bookings WHERE id=?', req.params.id);
  if (!b) return fail(res, 404, 'Booking not found.');
  if (b.user_id !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'You can only cancel your own bookings.');
  run('DELETE FROM bookings WHERE id=?', b.id);
  res.json({ ok: true });
});

// ---------- classes moved online ----------
function canRelease(user, cls) {
  return user.role === 'admin' || (user.programme && cls.programme.trim().toLowerCase() === user.programme.trim().toLowerCase());
}
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
  res.json({ ok: true });
});
app.delete('/api/releases', needUser, (req, res) => {
  const { class_id, date } = req.body || {};
  const c = one('SELECT * FROM classes WHERE id=?', class_id);
  if (!c) return fail(res, 404, 'Class not found.');
  if (!canRelease(req.user, c)) return fail(res, 403, 'You can only restore classes for your own programme.');
  if (clash(c.hall_id, date, c.start_min, c.end_min, c.id)) return fail(res, 409, 'The hall has been taken for this time, so the class cannot be restored.');
  run('DELETE FROM releases WHERE class_id=? AND date=?', c.id, date);
  res.json({ ok: true });
});

// ---------- admin: users ----------
app.get('/api/users', needAdmin, (req, res) => res.json(all('SELECT id,username,name,role,programme FROM users ORDER BY role,name')));
app.post('/api/users', needAdmin, (req, res) => {
  const { username = '', name = '', password = '', role = 'rep', programme = '' } = req.body || {};
  const u = String(username).trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(u)) return fail(res, 400, 'Username: 3–30 letters, numbers, dot, dash or underscore.');
  if (!String(name).trim()) return fail(res, 400, 'Enter the full name.');
  if (String(password).length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
  if (!['admin', 'rep'].includes(role)) return fail(res, 400, 'Invalid role.');
  if (role === 'rep' && !String(programme).trim()) return fail(res, 400, 'Enter the rep’s programme (e.g. BSc Computer Science L200).');
  if (one('SELECT id FROM users WHERE username=?', u)) return fail(res, 409, 'That username is taken.');
  run('INSERT INTO users (username,name,password_hash,role,programme) VALUES (?,?,?,?,?)', u, String(name).trim(), bcrypt.hashSync(String(password), 11), role, String(programme).trim());
  res.json({ ok: true });
});
app.patch('/api/users/:id/password', needAdmin, (req, res) => {
  const pw = String((req.body || {}).password || '');
  if (pw.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
  run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(pw, 11), req.params.id);
  run('DELETE FROM sessions WHERE user_id=?', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/users/:id', needAdmin, (req, res) => {
  if (+req.params.id === req.user.id) return fail(res, 400, 'You cannot delete your own account.');
  run('DELETE FROM users WHERE id=?', req.params.id);
  res.json({ ok: true });
});

// ---------- admin: halls and timetable ----------
app.patch('/api/halls/:id', needAdmin, (req, res) => {
  const seats = Number((req.body || {}).seats);
  if (!Number.isInteger(seats) || seats < 0 || seats > 5000) return fail(res, 400, 'Enter a valid seat count.');
  run('UPDATE halls SET seats=? WHERE id=?', seats, req.params.id);
  res.json({ ok: true });
});

const { importTimetable } = require('./timetable');

// CSV columns: hall, day, start, end, course, programme. Accepts {files:[{name,csv}]} or a single {csv}.
app.post('/api/timetable/import', needAdmin, (req, res) => {
  const body = req.body || {};
  const files = (Array.isArray(body.files) ? body.files : [{ name: 'file', csv: body.csv || '' }]).slice(0, 50);
  const r = importTimetable(files, body.replace !== false);
  if (r.errors.length) return res.status(400).json({ error: `${r.errors.length} problem(s) found. Nothing was imported.`, details: r.errors.slice(0, 20) });
  if (!r.imported && !r.skipped) return fail(res, 400, 'The files contain no timetable rows.');
  res.json({ imported: r.imported, skipped: r.skipped, files: files.length });
});
app.get('/api/timetable/count', needAdmin, (req, res) => res.json(one('SELECT COUNT(*) AS n FROM classes')));

// ---------- admin dashboard + messages ----------
app.get('/api/admin/overview', needAdmin, (req, res) => {
  const changes = all(`SELECT r.date,r.kind,r.new_date,r.new_start,r.new_end,r.created,c.course,c.programme,c.start_min,c.end_min,h.name AS hall,u.name AS by_name
      FROM releases r JOIN classes c ON c.id=r.class_id JOIN halls h ON h.id=c.hall_id LEFT JOIN users u ON u.id=r.by_user
      WHERE r.date>=? ORDER BY r.date,c.start_min`, nowParts().date);
  res.json({ changes, unread: one('SELECT COUNT(*) AS n FROM messages WHERE is_read=0').n });
});
app.post('/api/messages', needUser, (req, res) => {
  if (req.user.role !== 'rep') return fail(res, 403, 'Only programme reps send messages to the admin.');
  const body = String((req.body || {}).body || '').trim().slice(0, 500);
  if (!body) return fail(res, 400, 'Type a message first.');
  if (one('SELECT COUNT(*) AS n FROM messages WHERE user_id=? AND created>?', req.user.id, Date.now() - 3600000).n >= 10) return fail(res, 429, 'Too many messages. Try again later.');
  run('INSERT INTO messages (user_id,body,created) VALUES (?,?,?)', req.user.id, body, Date.now());
  res.json({ ok: true });
});
app.get('/api/messages', needUser, (req, res) => {
  const sel = 'SELECT m.id,m.body,m.created,m.is_read,m.reply,m.replied,u.name,u.programme FROM messages m JOIN users u ON u.id=m.user_id';
  res.json(req.user.role === 'admin' ? all(sel + ' ORDER BY m.is_read ASC, m.created DESC LIMIT 200') : all(sel + ' WHERE m.user_id=? ORDER BY m.created DESC LIMIT 50', req.user.id));
});
app.post('/api/messages/:id/read', needAdmin, (req, res) => { run('UPDATE messages SET is_read=1 WHERE id=?', req.params.id); res.json({ ok: true }); });
app.post('/api/messages/:id/reply', needAdmin, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return fail(res, 400, 'Type a reply first.');
  run('UPDATE messages SET reply=?, replied=?, is_read=1 WHERE id=?', text, Date.now(), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/messages/:id', needAdmin, (req, res) => { run('DELETE FROM messages WHERE id=?', req.params.id); res.json({ ok: true }); });

// ---------- static ----------
const PUB = path.join(__dirname, 'public');
if (fs.existsSync(PUB)) app.use(express.static(PUB, { maxAge: PROD ? '1h' : 0 }));
else { // flat layout (files uploaded without folders): serve only the three page files
  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  ['app.js', 'style.css'].forEach((f) => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));
}
app.use((err, req, res, next) => { console.error(err); fail(res, 500, 'Something went wrong. Please try again.'); });
app.listen(PORT, () => console.log(`Lecture Hall Finder running on port ${PORT}`));
