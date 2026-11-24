// On a brand-new (empty) database, load the timetable CSVs in /seed, set placeholder seat counts,
// and create the programme-rep accounts in seed/reps.json. Rep password comes from REP_PASSWORD.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { importTimetable } = require('./timetable');

module.exports = function bootstrap(bcrypt) {
  const seedDir = path.join(__dirname, 'seed');
  const dir = fs.existsSync(seedDir) ? seedDir : __dirname; // flat layout: CSVs sit next to server.js
  if (db.prepare('SELECT COUNT(*) AS n FROM classes').get().n > 0) return;
  const files = fs.readdirSync(dir).filter((f) => /^\d+-.*\.csv$/.test(f) || (dir === seedDir && f.endsWith('.csv'))).sort()
    .map((f) => ({ name: f, csv: fs.readFileSync(path.join(dir, f), 'utf8') }));
  if (!files.length) return;
  const r = importTimetable(files, true);
  if (r.errors.length) return console.log('Seed timetable has errors:\n' + r.errors.slice(0, 10).join('\n'));
  console.log(`First start: loaded ${r.imported} timetable classes from /seed.`);
  db.prepare("UPDATE halls SET seats = CASE grp WHEN 'SWLT' THEN 250 WHEN 'NLT' THEN 180 WHEN 'LT' THEN 120 ELSE 60 END WHERE seats = 0").run();
  const pw = process.env.REP_PASSWORD, f = path.join(dir, 'reps.json');
  if (pw && pw.length >= 8 && fs.existsSync(f)) {
    const ins = db.prepare("INSERT OR IGNORE INTO users (username,name,password_hash,role,programme) VALUES (?,?,?,'rep',?)");
    const hash = bcrypt.hashSync(pw, 10);
    JSON.parse(fs.readFileSync(f, 'utf8')).forEach((u) => ins.run(u.username, u.name, hash, u.programme));
    console.log('Programme rep accounts created from seed/reps.json.');
  } else console.log('No REP_PASSWORD (8+ characters) set, so no rep accounts were created. Add them in Manage.');
};
