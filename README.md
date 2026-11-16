# Hall Finder (UCC lecture halls)

Programme reps log in, see which of the 70 halls (SWLT 1-19, NLT 1-18, LT 1-22, CALC 1-11) are free,
book one, or release a hall when their class moves online. Administrators manage users and the timetable.

## Run it
Needs Node.js 22.13 or newer.

    npm install
    ADMIN_USERNAME=admin ADMIN_PASSWORD='choose-a-strong-one' npm start

Open http://localhost:3000 and sign in as the admin. If you skip ADMIN_PASSWORD, a random one is printed
in the console on first start.

## Set up for real use (as admin, under "Manage")
1. Enter the seat count for each hall.
2. Import the timetable CSV with columns: hall, day, start, end, course, programme
   Example row: SWLT 3, Monday, 08:00, 10:00, ECO 101, BA Economics L100
3. Create an account for each programme rep. Their "programme" text must match the timetable's programme
   column (capitals ignored). That is what lets a rep release only their own classes.

To try it before you have the real timetable: `npm run sample` loads made-up classes and 3 sample reps
(rep1-rep3, password ChangeMe123). Delete those accounts before going live.

## Deploy
Any host that runs Node and has a persistent disk (the database is a single file). Examples: a VPS,
Railway or Fly.io with a volume, Render with a paid disk. Set these environment variables:
- NODE_ENV=production (secure cookies; needs HTTPS)
- TRUST_PROXY=1 (when behind the host's proxy)
- DATA_DIR=/path/to/persistent/disk
- ADMIN_USERNAME and ADMIN_PASSWORD
Back up halls.db regularly. Hosts that wipe the disk on restart will lose your data.

## Notes
- Dates and times use UTC, which equals Ghana time (GMT).
- Passwords are hashed (bcrypt), sessions last 12 hours, and login attempts are rate-limited.
