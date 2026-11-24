// Shared timetable import used by the admin upload and by first-start seeding.
const db = require('./db');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const parseTime = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim()); if (!m) return null; const v = +m[1] * 60 + +m[2]; return +m[1] < 24 && +m[2] < 60 ? v : null; };

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// files: [{name, csv}]. Returns {imported, skipped, errors}. Writes nothing if there are errors.
function importTimetable(files, replace) {
  const halls = new Map(db.prepare('SELECT id,name FROM halls').all().map((h) => [h.name.toLowerCase().replace(/\s+/g, ''), h.id]));
  const errors = [], out = [], seen = new Set();
  if (!replace) db.prepare('SELECT hall_id,day,start_min,end_min,course FROM classes').all().forEach((c) => seen.add([c.hall_id, c.day, c.start_min, c.end_min, c.course].join('|')));
  let skipped = 0;
  for (const f of files) {
    const name = String(f.name || 'file').slice(0, 60);
    const rows = parseCsv(String(f.csv || ''));
    const hasHeader = rows.length && /^hall$/i.test(rows[0][0].trim());
    if (hasHeader) rows.shift();
    rows.forEach((r, i) => {
      const line = i + 1 + (hasHeader ? 1 : 0);
      const [hall = '', day = '', st = '', en = '', course = '', prog = ''] = r.map((c) => c.trim());
      const hid = halls.get(hall.toLowerCase().replace(/\s+/g, ''));
      const d = DAYS.indexOf(day.slice(0, 3).toLowerCase()), s = parseTime(st), e = parseTime(en);
      if (!hid) errors.push(`${name}, line ${line}: unknown hall "${hall}".`);
      else if (d < 0) errors.push(`${name}, line ${line}: unknown day "${day}".`);
      else if (s === null || e === null || e <= s) errors.push(`${name}, line ${line}: invalid times "${st}–${en}".`);
      else if (!course) errors.push(`${name}, line ${line}: course is missing.`);
      else {
        const key = [hid, d, s, e, course.slice(0, 80)].join('|');
        if (seen.has(key)) skipped++; else { seen.add(key); out.push([hid, d, s, e, course.slice(0, 80), prog.slice(0, 80)]); }
      }
    });
  }
  if (errors.length) return { imported: 0, skipped, errors };
  db.transaction(() => {
    if (replace) db.prepare('DELETE FROM classes').run();
    const ins = db.prepare('INSERT INTO classes (hall_id,day,start_min,end_min,course,programme) VALUES (?,?,?,?,?,?)');
    out.forEach((o) => ins.run(...o));
  })();
  return { imported: out.length, skipped, errors };
}
module.exports = { importTimetable };
