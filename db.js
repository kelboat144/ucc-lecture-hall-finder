const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'halls.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','rep')),
  programme TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS halls (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  grp TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  day INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  course TEXT NOT NULL,
  programme TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS releases (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (class_id, date)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  reply TEXT,
  replied INTEGER
);
CREATE INDEX IF NOT EXISTS idx_classes_hall_day ON classes(hall_id, day);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, hall_id);
`);

for (const col of ["kind TEXT NOT NULL DEFAULT 'online'", 'new_date TEXT', 'new_start INTEGER', 'new_end INTEGER', 'created INTEGER']) {
  try { db.exec('ALTER TABLE releases ADD COLUMN ' + col); } catch (e) { /* already there */ }
}


// ---------- version 2: roles, hierarchy, approvals, audit, notifications ----------
// Run once. users is rebuilt (the old CHECK on role cannot be altered in SQLite) and old data is kept:
// old 'admin' becomes 'super', old 'rep' becomes 'pr'. Nothing is deleted.
function migrate2() {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super','main','delegated','pr')),
      programme TEXT NOT NULL DEFAULT '',
      level INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','frozen','archived')),
      status_reason TEXT,
      status_by_role TEXT,
      must_change INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`INSERT INTO users_new (id,username,name,password_hash,role,programme,created)
      SELECT id,username,name,password_hash, CASE role WHEN 'admin' THEN 'super' ELSE 'pr' END, programme, ${Date.now()} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    for (const col of ["status TEXT NOT NULL DEFAULT 'approved'", 'decided_by INTEGER', 'decided_at INTEGER', 'decision_reason TEXT', 'cancel_req TEXT',
                       'alt_hall INTEGER', 'alt_date TEXT', 'alt_start INTEGER', 'alt_end INTEGER']) {
      try { db.exec('ALTER TABLE bookings ADD COLUMN ' + col); } catch (e) { /* exists */ }
    }
    try { db.exec('ALTER TABLE sessions ADD COLUMN device TEXT'); } catch (e) {}
    db.exec(`
CREATE TABLE IF NOT EXISTS permissions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  perm TEXT NOT NULL,
  expires INTEGER,
  granted_by INTEGER,
  PRIMARY KEY (user_id, perm)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  created INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created);
CREATE TABLE IF NOT EXISTS notif_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, category)
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created);
`);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.exec('PRAGMA foreign_keys = ON');
}
if (db.prepare('PRAGMA user_version').get().user_version < 2) migrate2();

// Halls are created once. Seat counts start at 0 and are set by the admin.
const GROUPS = [['SWLT', 19], ['NLT', 18], ['LT', 22], ['CALC', 11]];
if (db.prepare('SELECT COUNT(*) AS n FROM halls').get().n === 0) {
  const ins = db.prepare('INSERT INTO halls (name, grp, seats) VALUES (?,?,0)');
  for (const [g, n] of GROUPS) for (let i = 1; i <= n; i++) ins.run(`${g} ${i}`, g);
}

db.transaction = (fn) => (...a) => {
  db.exec('BEGIN');
  try { const r = fn(...a); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
module.exports = db;
