# Lecture Hall Finder (UCC)

Programme Representatives request lecture halls; administrators approve; the Super Admin owns the official timetable.

## Run it
Needs Node.js 22.13 or newer.

    npm install
    ADMIN_PASSWORD='long-secret' MAIN_ADMIN_PASSWORD='another' REP_PASSWORD='shared-temp' npm start

First start loads the timetable CSVs in /seed and creates: admin (Super Admin), mainadmin (Main Admin) and the sample rep accounts.
Every account created with a temporary password must choose its own at first sign-in.

## Backups and recovery
- Daily copies are written to `data/backups/` (newest 7 kept). These sit next to the database, so ALSO use
  Security > Download backup regularly and keep that file somewhere else.
- To restore: stop the app, replace `data/halls.db` with a backup file (delete any `halls.db-wal` / `halls.db-shm`), start the app.
- Super Admin locked out: on the server run `node reset-super.js "new password"`. There is no in-app reset for this account on purpose.
- Corrupt database: stop the app, restore the newest good backup as above, then check Audit log for anything done after that backup.

## Hosting note
The database is one file. Free hosts that wipe the disk on restart lose bookings, the audit log and history.
For real use, put `DATA_DIR` on a persistent disk.
