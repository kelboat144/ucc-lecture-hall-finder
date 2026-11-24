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
CREATE INDEX IF NOT EXISTS idx_classes_hall_day ON classes(hall_id, day);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, hall_id);
`);

for (const col of ["kind TEXT NOT NULL DEFAULT 'online'", 'new_date TEXT', 'new_start INTEGER', 'new_end INTEGER']) {
  try { db.exec('ALTER TABLE releases ADD COLUMN ' + col); } catch (e) { /* already there */ }
}

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
