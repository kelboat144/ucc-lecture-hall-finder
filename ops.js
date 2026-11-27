// Second-half features: maintenance, extensions, early release, timetable review + versions,
// academic calendar + yearly transition, confidential reports, petitions, security dashboard, backups.
const fs = require('fs');
const path = require('path');

module.exports = function install(app, c) {
  const { db, all, one, run, fmt, parseTime, validDate, dow, nowParts, inPast, fail, clean, audit, notify, superIds, deciderIds,
    needUser, needRole, needPerm, staff, can, clash, hallName, hallByName, slotText, bcrypt, crypto, tt, watch } = c;
  const dt = (date, m) => `${date}T${fmt(m)}`;
  const isDT = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || '')) && validDate(String(s).slice(0, 10)) && parseTime(String(s).slice(11)) !== null;
  const todayStr = () => nowParts().date;
  const err = (e, res) => fail(res, e.code || 500, e.code ? e.message : 'Something went wrong. Please try again.');
  const E = (msg, code) => Object.assign(new Error(msg), { code });

  // ================= hall maintenance =================
  function suggestHalls(date, s, e, notHall) { return all('SELECT id,name FROM halls WHERE id<>? ORDER BY id', notHall).filter((h) => !clash(h.id, date, s, e)).slice(0, 3); }
  app.get('/api/hall-blocks', needUser, staff, (req, res) =>
    res.json(all(`SELECT b.*, h.name AS hall FROM hall_blocks b JOIN halls h ON h.id=b.hall_id WHERE b.cleared_at IS NULL AND (b.end_at IS NULL OR b.end_at>?) ORDER BY b.start_at`, new Date().toISOString().slice(0, 16))));
  app.post('/api/hall-blocks', needUser, staff, needPerm('halls.manage'), (req, res) => {
    const { hall, start_at, end_at } = req.body || {}, why = clean((req.body || {}).reason, 200), h = hallByName(hall);
    if (!h) return fail(res, 400, 'Unknown hall.');
    if (!isDT(start_at) || (end_at && (!isDT(end_at) || end_at <= start_at))) return fail(res, 400, 'Enter a valid start, and an end after it (or leave the end empty).');
    if (!why) return fail(res, 400, 'A reason is required (repairs, cleaning, electrical fault, safety).');
    const E2 = end_at || '9999-12-31T00:00';
    const hit = all("SELECT * FROM bookings WHERE status='approved' AND hall_id=? AND date>=?", h.id, todayStr()).filter((b) => dt(b.date, b.start_min) < E2 && dt(b.date, b.end_min) > start_at);
    db.transaction(() => {
      run('INSERT INTO hall_blocks (hall_id,start_at,end_at,reason,created_by,created) VALUES (?,?,?,?,?,?)', h.id, start_at, end_at || null, why, req.user.id, Date.now());
      for (const b of hit) {            // never cancel: keep the booking, offer a replacement
        const sug = suggestHalls(b.date, b.start_min, b.end_min, h.id);
        if (sug.length) run("UPDATE bookings SET alt_hall=?, alt_date=?, alt_start=?, alt_end=?, alt_kind='maintenance', alt_state='offered', maint_note=? WHERE id=?", sug[0].id, b.date, b.start_min, b.end_min, why, b.id);
        else run('UPDATE bookings SET maint_note=? WHERE id=?', why, b.id);
        notify(b.user_id, 'halls', `${h.name} is unavailable`, `${slotText(b)} is affected (${why}). ` + (sug.length ? `Suggested instead: ${sug.map((x) => x.name).join(', ')}. Open My bookings to respond.` : 'No replacement hall was found. Contact the admin.'), 'mine');
      }
    })();
    audit(req.user, 'halls', 'marked_unavailable', h.name, why, null, { from: start_at, until: end_at || 'until cleared', affected_bookings: hit.length }, 'warning');
    res.json({ ok: true, affected: hit.length });
  });
  app.post('/api/hall-blocks/:id/clear', needUser, staff, needPerm('halls.manage'), (req, res) => {
    const b = one('SELECT * FROM hall_blocks WHERE id=? AND cleared_at IS NULL', req.params.id), why = clean((req.body || {}).reason, 200);
    if (!b) return fail(res, 404, 'Not found.');
    if (!why) return fail(res, 400, 'A reason is required.');
    run('UPDATE hall_blocks SET cleared_at=?, cleared_by=?, clear_reason=? WHERE id=?', Date.now(), req.user.id, why, b.id);
    audit(req.user, 'halls', 'restored', hallName(b.hall_id), why, { reason: b.reason }, null);
    res.json({ ok: true });
  });
  app.post('/api/bookings/:id/maint-response', needUser, needRole('pr'), (req, res) => {
    const b = one("SELECT * FROM bookings WHERE id=? AND user_id=? AND alt_kind='maintenance' AND alt_state='offered'", req.params.id, req.user.id);
    if (!b) return fail(res, 404, 'There is no replacement waiting for you.');
    const accept = !!(req.body || {}).accept;
    run('UPDATE bookings SET alt_state=? WHERE id=?', accept ? 'accepted' : 'declined', b.id);
    audit(req.user, 'bookings', accept ? 'replacement_accepted' : 'replacement_declined', `booking #${b.id}`, '');
    deciderIds().forEach((u) => notify(u, 'halls', 'Replacement hall ' + (accept ? 'accepted' : 'declined'), `${req.user.name} ${accept ? 'accepted a replacement and awaits your approval' : 'declined the replacement'} for booking #${b.id}.`, 'dash'));
    res.json({ ok: true });
  });
  app.post('/api/bookings/:id/maint-decision', needUser, staff, needPerm('bookings.decide'), (req, res) => {
    const why = clean((req.body || {}).reason, 300), approve = !!(req.body || {}).approve;
    if (!why) return fail(res, 400, 'A reason is required.');
    try {
      const b = db.transaction(() => {
        const b = one("SELECT * FROM bookings WHERE id=? AND alt_kind='maintenance' AND alt_state='accepted'", req.params.id);
        if (!b) throw E('Nothing is waiting for approval on this booking.', 404);
        if (approve) {
          const e = clash(b.alt_hall, b.alt_date, b.alt_start, b.alt_end, 0, b.id);
          if (e) throw E('The replacement is no longer available. ' + e, 409);
          run("UPDATE bookings SET hall_id=alt_hall, date=alt_date, start_min=alt_start, end_min=alt_end, alt_hall=NULL, alt_date=NULL, alt_start=NULL, alt_end=NULL, alt_kind=NULL, alt_state=NULL, maint_note=NULL, decision_reason=? WHERE id=?", why, b.id);
        } else run("UPDATE bookings SET alt_state='rejected' WHERE id=?", b.id);
        audit(req.user, 'bookings', approve ? 'replacement_approved' : 'replacement_rejected', `booking #${b.id}`, why, { slot: slotText(b) }, null);
        return b;
      })();
      notify(b.user_id, 'halls', approve ? 'Replacement hall approved' : 'Replacement not approved', `Booking #${b.id}: ${why}`, 'mine');
      res.json({ ok: true });
    } catch (e) { err(e, res); }
  });

  // ================= extensions + early release =================
  app.post('/api/bookings/:id/extend', needUser, needRole('pr'), (req, res) => {
    const b = one("SELECT * FROM bookings WHERE id=? AND user_id=? AND status='approved'", req.params.id, req.user.id), ne = parseTime((req.body || {}).new_end), why = clean((req.body || {}).reason, 200);
    if (!b) return fail(res, 404, 'Booking not found.');
    if (b.ext_end) return fail(res, 409, 'You already have an extension request waiting.');
    if (ne === null || ne <= b.end_min) return fail(res, 400, 'The new end time must be later than the current end time.');
    if (inPast(b.date, ne)) return fail(res, 400, 'That time has already passed.');
    if (!why) return fail(res, 400, 'Give a reason for the extension.');
    const conflict = clash(b.hall_id, b.date, b.end_min, ne, 0, b.id);       // flagged, never silently overridden
    run('UPDATE bookings SET ext_end=?, ext_reason=?, ext_conflict=? WHERE id=?', ne, why, conflict, b.id);
    audit(req.user, 'bookings', 'extension_requested', `booking #${b.id}`, why, { end: fmt(b.end_min) }, { end: fmt(ne), conflict });
    deciderIds().forEach((u) => notify(u, 'bookings', 'Extension requested', `${req.user.name} asks to extend ${slotText(b)} to ${fmt(ne)}.${conflict ? ' CONFLICT: ' + conflict : ''}`, 'dash'));
    res.json({ ok: true, conflict });
  });
  app.post('/api/bookings/:id/extension', needUser, staff, needPerm('bookings.decide'), (req, res) => {
    const why = clean((req.body || {}).reason, 300), approve = !!(req.body || {}).approve;
    if (!why) return fail(res, 400, 'A reason is required.');
    try {
      const b = db.transaction(() => {
        const b = one('SELECT * FROM bookings WHERE id=? AND ext_end IS NOT NULL', req.params.id);
        if (!b) throw E('No extension is waiting on this booking.', 404);
        if (approve) {
          const e = clash(b.hall_id, b.date, b.end_min, b.ext_end, 0, b.id);
          if (e) throw E(e + ' The official timetable and other bookings come first, so reject this extension.', 409);
          run('UPDATE bookings SET end_min=ext_end, ext_end=NULL, ext_reason=NULL, ext_conflict=NULL WHERE id=?', b.id);
        } else run('UPDATE bookings SET ext_end=NULL, ext_reason=NULL, ext_conflict=NULL WHERE id=?', b.id);
        audit(req.user, 'bookings', approve ? 'extension_approved' : 'extension_rejected', `booking #${b.id}`, why, { end: fmt(b.end_min) }, approve ? { end: fmt(b.ext_end) } : null);
        return b;
      })();
      notify(b.user_id, 'bookings', approve ? 'Extension approved' : 'Extension rejected', `${slotText(b)}: ${why}`, 'mine');
      res.json({ ok: true });
    } catch (e) { err(e, res); }
  });
  // Early release: the app cannot see who is in a hall, so a rep reports "vacated" and an admin confirms.
  app.post('/api/bookings/:id/vacated', needUser, needRole('pr'), (req, res) => {
    const n = nowParts(), b = one("SELECT * FROM bookings WHERE id=? AND user_id=? AND status='approved' AND date=? AND start_min<=? AND end_min>?", req.params.id, req.user.id, n.date, n.min, n.min);
    if (!b) return fail(res, 400, 'Early release only applies to a booking that is in progress today.');
    run('UPDATE bookings SET release_req=1 WHERE id=?', b.id);
    audit(req.user, 'bookings', 'vacated_reported', `booking #${b.id}`, clean((req.body || {}).reason, 200));
    deciderIds().forEach((u) => notify(u, 'halls', 'Hall reported empty', `${req.user.name} says ${slotText(b)} is vacated. Confirm to release it.`, 'dash'));
    res.json({ ok: true });
  });
  app.post('/api/bookings/:id/release', needUser, staff, needPerm('bookings.cancel'), (req, res) => {
    const why = clean((req.body || {}).reason, 300), n = nowParts(), b = one("SELECT * FROM bookings WHERE id=? AND status='approved' AND date=? AND start_min<? AND end_min>?", req.params.id, n.date, n.min, n.min);
    if (!why) return fail(res, 400, 'A reason is required.');
    if (!b) return fail(res, 400, 'Only a booking that is in progress today can be released early.');
    run('UPDATE bookings SET end_min=?, released_at=?, release_req=0 WHERE id=?', n.min, Date.now(), b.id);
    audit(req.user, 'bookings', 'early_release', `booking #${b.id}`, why, { end: fmt(b.end_min) }, { end: fmt(n.min) });
    notify(b.user_id, 'halls', 'Hall released early', `${hallName(b.hall_id)} was released at ${fmt(n.min)}. ${why}`, 'mine');
    res.json({ ok: true });
  });

  // ================= timetable submissions, review, versions =================
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  function conflictsFor(rows, programme) {
    const out = [], up = all("SELECT b.* FROM bookings b WHERE b.status='approved' AND b.date>=?", todayStr());
    rows.forEach(([hid, d, s, e, course]) => {
      const o = one('SELECT course,programme FROM classes WHERE hall_id=? AND day=? AND start_min<? AND end_min>? AND LOWER(programme)<>LOWER(?)', hid, d, e, s, programme);
      if (o) out.push(`${hallName(hid)} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]} ${fmt(s)}–${fmt(e)} (${course}) overlaps the official class ${o.course} (${o.programme}).`);
      up.filter((b) => b.hall_id === hid && dow(b.date) === d && b.start_min < e && b.end_min > s).slice(0, 1).forEach((b) => out.push(`${hallName(hid)} on ${b.date} ${fmt(b.start_min)}–${fmt(b.end_min)}: an approved booking exists. It is kept and flagged for you to resolve.`));
    });
    rows.forEach((a, i) => rows.slice(i + 1).forEach((b) => { if (a[1] === b[1] && a[2] < b[3] && a[3] > b[2]) out.push(`Two of this programme's classes overlap on the same day (${a[4]} and ${b[4]}).`); }));
    return out.slice(0, 50);
  }
  app.post('/api/timetable/submissions', needUser, needRole('pr'), (req, res) => {
    const csv = String((req.body || {}).csv || ''), name = clean((req.body || {}).name, 80);
    if (csv.length > 200000) return fail(res, 413, 'The file is too large (200 KB maximum).');
    if (name && !/\.csv$/i.test(name)) return fail(res, 400, 'Only .csv files are accepted.');
    const r = tt.parseRows([{ name: name || 'file', csv }]);
    if (r.errors.length) return res.status(400).json({ error: `${r.errors.length} problem(s) found. Nothing was submitted.`, details: r.errors.slice(0, 20) });
    if (!r.out.length) return fail(res, 400, 'The file has no timetable rows.');
    if (r.out.length > 500) return fail(res, 400, 'Too many rows (500 maximum).');
    const mine = req.user.programme.trim().toLowerCase(), bad = r.out.filter((o) => o[5] && o[5].trim().toLowerCase() !== mine);
    if (bad.length) return fail(res, 400, `${bad.length} row(s) belong to another programme. You can only submit ${req.user.programme}.`);
    if (one("SELECT id FROM ts_submissions WHERE user_id=? AND status='pending'", req.user.id)) return fail(res, 409, 'You already have a submission waiting for review.');
    const rows = r.out.map((o) => [o[0], o[1], o[2], o[3], o[4], req.user.programme]);
    const x = run('INSERT INTO ts_submissions (user_id,programme,filename,csv,row_count,report,created) VALUES (?,?,?,?,?,?,?)', req.user.id, req.user.programme, name, csv, rows.length, JSON.stringify(conflictsFor(rows, req.user.programme)), Date.now());
    audit(req.user, 'timetables', 'submitted', `submission #${Number(x.lastInsertRowid)}`, req.user.programme, null, { rows: rows.length });
    superIds().forEach((u) => notify(u, 'timetables', 'Timetable submitted for review', `${req.user.name} submitted ${rows.length} rows for ${req.user.programme}.`, 'tt'));
    res.json({ id: Number(x.lastInsertRowid), rows: rows.length });
  });
  app.get('/api/timetable/submissions', needUser, (req, res) => {
    if (req.user.role === 'pr') return res.json(all('SELECT id,programme,filename,row_count,status,reason,created FROM ts_submissions WHERE user_id=? ORDER BY id DESC LIMIT 20', req.user.id));
    if (req.user.role !== 'super') return fail(res, 403, 'Only the Super Admin reviews timetable submissions.');
    res.json(all('SELECT s.id,s.programme,s.filename,s.row_count,s.status,s.reason,s.created,s.report,u.name AS by_name FROM ts_submissions s JOIN users u ON u.id=s.user_id ORDER BY (s.status=\'pending\') DESC, s.id DESC LIMIT 50').map((s) => ({ ...s, report: JSON.parse(s.report || '[]') })));
  });
  app.get('/api/timetable/submissions/:id', needUser, needRole('super'), (req, res) => {
    const s = one('SELECT * FROM ts_submissions WHERE id=?', req.params.id);
    if (!s) return fail(res, 404, 'Not found.');
    const r = tt.parseRows([{ name: s.filename, csv: s.csv }]), rows = r.out.map((o) => [hallName(o[0]), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][o[1]], fmt(o[2]), fmt(o[3]), o[4]]);
    res.json({ programme: s.programme, rows: rows.slice(0, 60), total: rows.length, conflicts: conflictsFor(r.out.map((o) => [o[0], o[1], o[2], o[3], o[4], s.programme]), s.programme), replaces: one('SELECT COUNT(*) AS n FROM classes WHERE LOWER(programme)=LOWER(?)', s.programme).n });
  });
  app.post('/api/timetable/submissions/:id/decision', needUser, needRole('super'), (req, res) => {
    const { decision, force } = req.body || {}, why = clean((req.body || {}).reason, 300);
    if (!why) return fail(res, 400, 'A reason is required.');
    try {
      const s = db.transaction(() => {
        const s = one("SELECT * FROM ts_submissions WHERE id=? AND status='pending'", req.params.id);
        if (!s) throw E('This submission is no longer pending.', 409);
        if (decision === 'approve') {
          const r = tt.parseRows([{ name: s.filename, csv: s.csv }]), rows = r.out.map((o) => [o[0], o[1], o[2], o[3], o[4], s.programme]), conf = conflictsFor(rows, s.programme);
          if (conf.length && !force) throw Object.assign(E(`${conf.length} conflict(s) found. Review them, then confirm to publish anyway.`, 409), { conflicts: conf });
          tt.snapshot(`Before publishing ${s.programme} (submission #${s.id})`, req.user.name);
          run('DELETE FROM classes WHERE LOWER(programme)=LOWER(?)', s.programme);   // only this programme is replaced, never the whole timetable
          const ins = db.prepare('INSERT INTO classes (hall_id,day,start_min,end_min,course,programme) VALUES (?,?,?,?,?,?)'); rows.forEach((o) => ins.run(...o));
          run("UPDATE ts_submissions SET status='approved', reviewed_by=?, reviewed_at=?, reason=? WHERE id=?", req.user.id, Date.now(), why, s.id);
        } else if (decision === 'reject') run("UPDATE ts_submissions SET status='rejected', reviewed_by=?, reviewed_at=?, reason=? WHERE id=?", req.user.id, Date.now(), why, s.id);
        else throw E('Choose approve or reject.', 400);
        audit(req.user, 'timetables', decision === 'approve' ? 'published' : 'rejected', `${s.programme} (submission #${s.id})`, why, null, { rows: s.row_count }, 'warning');
        return s;
      })();
      notify(s.user_id, 'timetables', decision === 'approve' ? 'Timetable published' : 'Timetable rejected', `${s.programme}: ${why}`, 'tt');
      res.json({ ok: true });
    } catch (e) { if (e.conflicts) return res.status(409).json({ error: e.message, conflicts: e.conflicts, needs_force: true }); err(e, res); }
  });
  app.get('/api/timetable/versions', needUser, needRole('super'), (req, res) => res.json(all("SELECT id,created,created_by,note,json_array_length(rows_json) AS n FROM timetable_versions ORDER BY id DESC LIMIT 40")));
  app.post('/api/timetable/versions/:id/restore', needUser, needRole('super'), (req, res) => {
    const why = clean((req.body || {}).reason, 300);
    if (!why) return fail(res, 400, 'A reason is required.');
    if (!one('SELECT id FROM timetable_versions WHERE id=?', req.params.id)) return fail(res, 404, 'Not found.');
    tt.snapshot(`Before restoring version #${req.params.id}`, req.user.name);
    tt.restore(+req.params.id);
    audit(req.user, 'timetables', 'version_restored', `version #${req.params.id}`, why, null, null, 'warning');
    res.json({ ok: true });
  });
  app.get('/api/my-timetable', needUser, needRole('pr'), (req, res) =>
    res.json(all('SELECT h.name AS hall,c.day,c.start_min,c.end_min,c.course FROM classes c JOIN halls h ON h.id=c.hall_id WHERE LOWER(c.programme)=LOWER(?) ORDER BY c.day,c.start_min', req.user.programme)));

  // ================= academic calendar + yearly transition =================
  const lvlOf = (u) => u.level || +((/L(\d{3})\s*$/i.exec(u.programme) || [])[1]) || null;
  function runTransition(year, actor) {
    const created = [], skipped = [];
    db.transaction(() => {
      const y = one('SELECT * FROM academic_years WHERE id=? AND transitioned_at IS NULL', year.id);
      if (!y) throw E('This academic year has already been processed.', 409);
      tt.snapshot(`Archive before ${y.label}`, actor ? actor.name : 'System');
      const prs = all("SELECT * FROM users WHERE role='pr' AND status='active'");
      const bases = [...new Set(prs.filter((u) => lvlOf(u) === 100).map((u) => u.programme.replace(/\s*L100\s*$/i, '').trim()))];
      for (const u of prs) {
        const l = lvlOf(u);
        if (!l) { skipped.push(u.username); continue; }
        if (l >= 400) { run("UPDATE users SET status='archived', status_reason=?, status_by_role='super' WHERE id=?", `Retired after Level 400 (${y.label})`, u.id); run('DELETE FROM sessions WHERE user_id=?', u.id); continue; }
        const nl = l + 100, np = /L\d{3}\s*$/i.test(u.programme) ? u.programme.replace(/L\d{3}\s*$/i, 'L' + nl) : u.programme;
        run('UPDATE users SET level=?, programme=? WHERE id=?', nl, np, u.id);
      }
      const yr = y.start_date.slice(2, 4);
      for (const b of bases) {                       // new Level 100 intake accounts
        let base = slug(b).slice(0, 18) + 'l100', name = base + yr, i = 1;
        while (one('SELECT id FROM users WHERE username=?', name)) name = base + yr + '_' + (++i);
        const pw = crypto.randomBytes(6).toString('base64url');
        run("INSERT INTO users (username,name,password_hash,role,programme,level,must_change,created) VALUES (?,?,?,'pr',?,100,1,?)", name, `${b} L100 Rep`, bcrypt.hashSync(pw, 10), `${b} L100`, Date.now());
        created.push({ username: name, programme: `${b} L100`, temp_password: pw });
      }
      run('UPDATE academic_years SET transitioned_at=? WHERE id=?', Date.now(), y.id);
    })();
    audit(actor || null, 'calendar', 'year_transition', year.label, '', null, { new_accounts: created.length, needs_attention: skipped }, 'warning');
    superIds().forEach((u) => notify(u, 'security', `Academic year ${year.label} started`, `Cohorts advanced. ${created.length} new Level 100 account(s) created. The previous timetable stays active until you publish the new one.`, 'cal'));
    return { created, skipped };
  }
  function autoTransitions() {
    const t = todayStr(), floor = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    all('SELECT * FROM academic_years WHERE transitioned_at IS NULL AND auto=1 AND start_date<=? AND start_date>=? ORDER BY start_date', t, floor).forEach((y) => { try { runTransition(y, null); } catch (e) { console.error('transition', e.message); } });
  }
  setInterval(autoTransitions, 3600000); setTimeout(autoTransitions, 5000);

  app.get('/api/calendar', needUser, (req, res) => {
    const t = todayStr();
    res.json(all('SELECT * FROM academic_years ORDER BY start_date DESC').map((y) => ({ ...y, state: y.transitioned_at ? 'processed' : y.start_date > t ? 'upcoming' : 'current', periods: all('SELECT * FROM calendar_periods WHERE year_id=? ORDER BY start_date', y.id) })));
  });
  const okRange = (a, b) => validDate(String(a)) && validDate(String(b)) && b >= a;
  app.post('/api/calendar/years', needUser, needRole('super'), (req, res) => {
    const { label, start_date, end_date } = req.body || {}, l = clean(label, 20);
    if (!l || !okRange(start_date, end_date)) return fail(res, 400, 'Enter a label and valid start and end dates.');
    if (one('SELECT id FROM academic_years WHERE label=?', l)) return fail(res, 409, 'That academic year already exists.');
    const auto = start_date > todayStr() ? 1 : 0;       // a year that has already started is never auto-advanced
    run('INSERT INTO academic_years (label,start_date,end_date,auto) VALUES (?,?,?,?)', l, start_date, end_date, auto);
    audit(req.user, 'calendar', 'year_added', l, '', null, { start_date, end_date, auto_transition: !!auto });
    res.json({ ok: true, auto_transition: !!auto });
  });
  app.patch('/api/calendar/years/:id', needUser, needRole('super'), (req, res) => {
    const y = one('SELECT * FROM academic_years WHERE id=?', req.params.id), { start_date, end_date, confirm } = req.body || {};
    if (!y) return fail(res, 404, 'Not found.');
    if (!okRange(start_date, end_date)) return fail(res, 400, 'Enter valid dates.');
    const inProgress = y.transitioned_at || y.start_date <= todayStr();
    if (inProgress && !confirm) return res.status(409).json({ error: 'Impact', needs_confirm: true, impact: y.transitioned_at ? 'This year has already been processed. Cohorts will NOT advance again; only the dates change.' : 'This year has already started. Changing the dates affects anything that depends on them.' });
    run('UPDATE academic_years SET start_date=?, end_date=?, auto=? WHERE id=?', start_date, end_date, start_date > todayStr() && !y.transitioned_at ? 1 : y.auto, y.id);
    audit(req.user, 'calendar', 'year_changed', y.label, '', { start_date: y.start_date, end_date: y.end_date }, { start_date, end_date }, 'warning');
    res.json({ ok: true });
  });
  app.post('/api/calendar/periods', needUser, needRole('super'), (req, res) => {
    const { year_id, kind, start_date, end_date } = req.body || {}, l = clean((req.body || {}).label, 40);
    if (!one('SELECT id FROM academic_years WHERE id=?', year_id) || !['semester', 'vacation', 'registration', 'other'].includes(kind) || !l || !okRange(start_date, end_date)) return fail(res, 400, 'Choose a year, a type, a label and valid dates.');
    run('INSERT INTO calendar_periods (year_id,kind,label,start_date,end_date) VALUES (?,?,?,?,?)', year_id, kind, l, start_date, end_date);
    audit(req.user, 'calendar', 'period_added', `${kind}: ${l}`, '', null, { start_date, end_date });
    res.json({ ok: true });
  });
  app.delete('/api/calendar/periods/:id', needUser, needRole('super'), (req, res) => { run('DELETE FROM calendar_periods WHERE id=?', req.params.id); audit(req.user, 'calendar', 'period_removed', `#${req.params.id}`, ''); res.json({ ok: true }); });
  app.post('/api/calendar/years/:id/transition', needUser, needRole('super'), (req, res) => {
    const y = one('SELECT * FROM academic_years WHERE id=?', req.params.id);
    if (!y) return fail(res, 404, 'Not found.');
    if ((req.body || {}).confirm !== 'RUN') return fail(res, 400, 'Type RUN to confirm.');
    try { res.json(runTransition(y, req.user)); } catch (e) { err(e, res); }
  });

  // ================= confidential reports + petitions =================
  const REPORT_CATS = ['inappropriate behaviour', 'misuse of the booking system', 'unresolved issue', 'suspicious activity'];
  app.post('/api/reports', needUser, (req, res) => {
    const { category } = req.body || {}, body = clean((req.body || {}).body, 1000);
    if (!REPORT_CATS.includes(category) || !body) return fail(res, 400, 'Choose a category and describe the concern.');
    if (one('SELECT COUNT(*) AS n FROM reports WHERE user_id=? AND created>?', req.user.id, Date.now() - 3600000).n >= 5) return fail(res, 429, 'Too many reports. Try again later.');
    run('INSERT INTO reports (user_id,category,body,created) VALUES (?,?,?,?)', req.user.id, category, body, Date.now());
    superIds().forEach((u) => notify(u, 'security', 'New confidential report', `Category: ${category}.`, 'sec'));   // nobody else, and the reported person is not told
    res.json({ ok: true });
  });
  app.get('/api/reports', needUser, (req, res) => {
    if (req.user.role !== 'super') return res.json(all('SELECT id,category,status,created FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 20', req.user.id));
    audit(req.user, 'reports', 'viewed_reports', 'report inbox', '');
    res.json(all('SELECT r.*,u.name AS by_name,u.role AS by_role,u.programme FROM reports r JOIN users u ON u.id=r.user_id ORDER BY (r.status=\'resolved\'), r.id DESC LIMIT 100'));
  });
  app.post('/api/reports/:id/update', needUser, needRole('super'), (req, res) => {
    const { status } = req.body || {}, findings = clean((req.body || {}).findings, 1000), r = one('SELECT * FROM reports WHERE id=?', req.params.id);
    if (!r || !['open', 'investigating', 'resolved'].includes(status)) return fail(res, 400, 'Invalid request.');
    run('UPDATE reports SET status=?, findings=?, updated=? WHERE id=?', status, findings, Date.now(), r.id);
    audit(req.user, 'reports', 'report_' + status, `report #${r.id}`, findings);
    if (status === 'resolved') notify(r.user_id, 'messages', 'Your report was reviewed', 'The Super Admin has reviewed and closed your report.', '');
    res.json({ ok: true });
  });
  app.post('/api/petitions', needUser, needRole('main'), (req, res) => {
    const ref = clean((req.body || {}).ref, 80), body = clean((req.body || {}).body, 1000);
    if (!body) return fail(res, 400, 'Explain what you are asking the Super Admin to reconsider.');
    run('INSERT INTO petitions (user_id,ref,body,created) VALUES (?,?,?,?)', req.user.id, ref, body, Date.now());
    audit(req.user, 'users', 'petition_sent', ref || 'general', body.slice(0, 120));
    superIds().forEach((u) => notify(u, 'messages', 'Petition from the Main Admin', ref || body.slice(0, 80), 'sec'));
    res.json({ ok: true });
  });
  app.get('/api/petitions', needUser, needRole('super', 'main'), (req, res) =>
    res.json(req.user.role === 'super' ? all('SELECT p.*,u.name AS by_name FROM petitions p JOIN users u ON u.id=p.user_id ORDER BY (p.status<>\'open\'), p.id DESC LIMIT 50') : all('SELECT * FROM petitions WHERE user_id=? ORDER BY id DESC LIMIT 20', req.user.id)));
  app.post('/api/petitions/:id/decide', needUser, needRole('super'), (req, res) => {   // a petition never changes anything by itself
    const p = one("SELECT * FROM petitions WHERE id=? AND status='open'", req.params.id), response = clean((req.body || {}).response, 500), accept = !!(req.body || {}).accept;
    if (!p) return fail(res, 404, 'Not found.');
    if (!response) return fail(res, 400, 'Write a response.');
    run('UPDATE petitions SET status=?, response=?, decided=? WHERE id=?', accept ? 'accepted' : 'declined', response, Date.now(), p.id);
    audit(req.user, 'users', accept ? 'petition_accepted' : 'petition_declined', p.ref || `petition #${p.id}`, response);
    notify(p.user_id, 'messages', 'Your petition was ' + (accept ? 'accepted' : 'declined'), response.slice(0, 120), '');
    res.json({ ok: true });
  });

  // ================= security dashboard + backups =================
  app.get('/api/security', needUser, needRole('super'), (req, res) => {
    const now = Date.now();
    res.json({
      sessions: all(`SELECT u.id AS user_id,u.name,u.role,u.username,s.device,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.role IN ('super','main','delegated') AND s.expires>? ORDER BY s.last_seen DESC`, now)
        .map((s) => ({ ...s, working: !!s.last_seen && now - s.last_seen < 5 * 60000 })),
      alerts: all("SELECT id,actor_name,action,target,reason,severity,created FROM audit_log WHERE severity IN ('warning','critical') ORDER BY id DESC LIMIT 30"),
      counts: { reports: one("SELECT COUNT(*) AS n FROM reports WHERE status<>'resolved'").n, petitions: one("SELECT COUNT(*) AS n FROM petitions WHERE status='open'").n,
        submissions: one("SELECT COUNT(*) AS n FROM ts_submissions WHERE status='pending'").n, locked: one('SELECT COUNT(*) AS n FROM users WHERE locked_until>?', now).n },
    });
  });
  app.post('/api/users/:id/revoke', needUser, needRole('super'), (req, res) => {
    const why = clean((req.body || {}).reason, 300), u = one('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u || u.role === 'super') return fail(res, 400, 'Not allowed.');
    if (!why) return fail(res, 400, 'A reason is required.');
    run('DELETE FROM sessions WHERE user_id=?', u.id);
    audit(req.user, 'security', 'sessions_revoked', u.username, why, null, null, 'warning');
    res.json({ ok: true });
  });
  function backupTo(file) { db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); }
  app.get('/api/backup', needUser, needRole('super'), (req, res) => {
    const f = path.join(db.dir, `download-${Date.now()}.db`);
    try { backupTo(f); } catch (e) { return fail(res, 500, 'The backup could not be created.'); }
    audit(req.user, 'security', 'backup_downloaded', 'database', '', null, null, 'warning');
    res.download(f, `lecture-hall-finder-${todayStr()}.db`, () => fs.unlink(f, () => {}));
  });
  function autoBackup() {                             // daily copy beside the database, newest 7 kept (keep a downloaded copy elsewhere too)
    try {
      const dir = path.join(db.dir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `halls-${todayStr()}.db`); if (!fs.existsSync(f)) backupTo(f);
      fs.readdirSync(dir).filter((x) => x.startsWith('halls-')).sort().slice(0, -7).forEach((x) => fs.unlinkSync(path.join(dir, x)));
    } catch (e) { console.error('backup failed:', e.message); }
  }
  setInterval(autoBackup, 24 * 3600000); setTimeout(autoBackup, 10000);
};
