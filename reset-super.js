// Recovery for the Super Admin. There is no in-app reset for this account, by design.
// Run on the server that holds the database:   node reset-super.js "new-password-here"
const bcrypt = require('bcryptjs');
const db = require('./db');
const pw = process.argv[2];
if (!pw || pw.length < 8) { console.log('Usage: node reset-super.js "new password (8+ characters)"'); process.exit(1); }
const u = db.prepare("SELECT id,username FROM users WHERE role='super'").get();
if (!u) { console.log('No Super Admin account found.'); process.exit(1); }
db.prepare("UPDATE users SET password_hash=?, must_change=1, failed=0, locked_until=0, status='active' WHERE id=?").run(bcrypt.hashSync(pw, 11), u.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
db.prepare("INSERT INTO audit_log (actor_name,actor_role,module,action,target,reason,severity,created) VALUES ('Server console','system','security','super_recovery',?,'Recovered from the server',?, ?)").run(u.username, 'critical', Date.now());
console.log(`Password reset for ${u.username}. You will be asked to change it at next sign-in.`);
