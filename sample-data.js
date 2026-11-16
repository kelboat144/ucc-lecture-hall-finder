// OPTIONAL: fills the timetable with made-up classes and creates 3 sample rep accounts.
// Use it to try the app before you have the real timetable. Run: npm run sample
const bcrypt = require('bcryptjs');
const db = require('./db');
let seed = 2026; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const PROGS = ['BSc Computer Science L200', 'BA Economics L100', 'BEd Basic Education L300', 'BSc Biology L200', 'BCom Accounting L300', 'BSc Nursing L100'];
const COURSES = ['ECO 101', 'CSC 205', 'EDU 220', 'BIO 201', 'ACC 201', 'NUR 105', 'MAT 111', 'STA 120', 'ENG 101', 'PSY 101', 'GEO 130', 'ICT 301'];
db.exec('DELETE FROM classes');
const halls = db.prepare('SELECT id FROM halls').all();
const ins = db.prepare('INSERT INTO classes (hall_id,day,start_min,end_min,course,programme) VALUES (?,?,?,?,?,?)');
db.exec('BEGIN');
for (const h of halls) for (let d = 1; d <= 5; d++) {
  let t = 8 * 60;
  while (t < 18 * 60) {
    const len = rnd() < 0.25 ? 180 : 120; if (t + len > 18 * 60) break;
    if (rnd() < 0.55) ins.run(h.id, d, t, t + len, COURSES[Math.floor(rnd() * COURSES.length)], PROGS[Math.floor(rnd() * PROGS.length)]);
    t += len + (rnd() < 0.3 ? 60 : 0);
  }
}
db.prepare('UPDATE halls SET seats = CASE grp WHEN \'SWLT\' THEN 250 WHEN \'NLT\' THEN 180 WHEN \'LT\' THEN 120 ELSE 60 END WHERE seats=0').run();
const user = db.prepare('INSERT OR IGNORE INTO users (username,name,password_hash,role,programme) VALUES (?,?,?,?,?)');
PROGS.slice(0, 3).forEach((p, i) => user.run(`rep${i + 1}`, `Sample Rep ${i + 1}`, bcrypt.hashSync('ChangeMe123', 10), 'rep', p));
db.exec('COMMIT');
console.log('Sample timetable loaded. Sample reps: rep1, rep2, rep3 (password ChangeMe123). Delete them in Manage before going live.');
