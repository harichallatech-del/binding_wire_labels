BINDING WIRE LABEL STUDIO  v2  (SQLite via sql.js)
===================================================
START
  1. Install Node.js LTS once (https://nodejs.org).
  2. Windows: double-click start-windows.bat      Mac/Linux: ./start-mac-linux.sh
     (first run downloads sql.js with npm - internet needed once)
  3. Your browser opens http://127.0.0.1:3001

PAGES
  Print     pick a date and tap batch tiles. The A4 DOCX, sheet preview, and browser Print share the same layout, defaulting to 3 columns by 10 compact rows. Labels have a plain centered title, size and coil on one line, then weight, quality, and batch number. DOCX downloads do not change print status; browser printing is saved only after you confirm "printed OK".
  Batches   search / filter / page through every batch; open a row for its print log and version history; reprint, void or restore.
  Insights  totals, last-30-day chart, per-product table, database health, backup, restore and download of the .sqlite file.

YOUR DATA   data/labels.sqlite  (open it with DB Browser for SQLite)   data/backups/  (daily/EOD snapshots, last 14 of each kept; manual and pre-restore copies retained)
  Backup and database-download filenames include the most recently registered lot ID as a reference; each file still contains the whole database.
  Labels are numbered per lot, e.g. J2286-01-0001. Reprints reuse the same per-lot count.
  Restore is available from Insights for local or connected Drive backups. It validates SQLite integrity and foreign keys before replacing the database, and keeps a separate pre-restore safety copy.
  Keep an offline copy of data/backups and periodically test restore. Never edit labels.sqlite while the server is running.
  Other PCs on your network: set HOST=0.0.0.0 before starting, then open http://<this-pc-ip>:3001

GOOGLE DRIVE OFF-SITE BACKUPS
  1. In Google Cloud, enable the Google Drive API and create an OAuth 2.0 Web application client.
  2. Add http://127.0.0.1:3001/api/drive/callback as an authorized redirect URI.
  3. Copy .env.example to .env and fill in GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.
     The app loads .env on startup. Keep .env private; it is ignored by git.
     For a non-default port, set GOOGLE_OAUTH_REDIRECT_URI to the matching callback URI.
  4. In Insights, connect each of the two Google accounts using Google's sign-in page. Do not enter account passwords in this app.
     For LAN use without HTTPS, connect accounts from the server computer at http://127.0.0.1:3001; other PCs can then use the app and its Drive backups.
  5. The app creates Binding Wire Label Studio/Backups/year/month in each Drive and uploads a daily backup at 23:00 server-local time.
     Set DRIVE_BACKUP_TIME=HH:MM to change the schedule. Manual backups also attempt upload to both accounts; failures are shown in Insights.
  To start the server for LAN access, set HOST=0.0.0.0 in .env. Remote Google sign-in requires a stable HTTPS callback; do not use localhost callbacks from another PC.
  OAuth tokens are stored separately in data/google-drive-tokens.json (file mode 0600 where supported) and are not included in the SQLite backups.

TEST
  npm test    runs the isolated schema migration, label sequence, backup and restore integration test.

BATCH NUMBER  month letter (A=Jan..L=Dec) + 3rd digit of year + day + 4th digit of year + "-" + serial.
  28 Oct 2026, serial 1 = J2286-01   (lotnumbergenerator pattern without the expiry part)
  The database derives it from date+serial, so it cannot disagree. Printed batches are locked: reprints use the original label data.
