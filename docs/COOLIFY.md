# Deploying the dashboard on Coolify

The repo root has a `Dockerfile` that builds and runs the dashboard (`frontend/`, Next.js) on port 3000.

## Create the application

1. Coolify → **+ New** → **Application** → this Git repository, branch `main`.
2. **Build Pack**: `Dockerfile`. **Base Directory**: `/`. **Dockerfile Location**: `/Dockerfile`.
3. **Ports Exposes**: `3000`. Set the domain (e.g. `https://bidding.example.com`); Coolify's proxy adds HTTPS.
4. Add the environment variables below, then **Deploy**.

The image has a health check (`/robots.txt`), so Coolify shows the container as healthy once Next.js answers.

## Environment variables

Tick **Build Variable** for the two `NEXT_PUBLIC_*` ones: they are put into the browser code when the image is
built, so changing them needs a redeploy. The build stops with a message if `NEXT_PUBLIC_SUPABASE_URL` is missing.

| Variable | Build? | What it is |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase publishable (anon) key |
| `SUPABASE_URL` | | Supabase project URL (server side) |
| `SUPABASE_KEY` | | Supabase secret key (server side only) |
| `CRON_SECRET` | | Bearer secret the Supabase schedules send to `/api/philgeps-update`, `/api/ps-sync`, `/api/ps-keepalive`, ... |
| `DASHBOARD_URL` | | This deployment's public URL (links in award e-mails); otherwise the Vercel URL is used |
| `PS_PHILGEPS_USERNAME`, `PS_PHILGEPS_PASSWORD` | | PS-PhilGEPS account |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | | Outgoing e-mail (Message Hospitals, award notices) |
| `GITHUB_OCR_TOKEN`, `GITHUB_REPOSITORY_NAME` | | Starting the GitHub Actions jobs (OCR, Connect PS-PhilGEPS) |
| `GOOGLE_VISION_API_KEY`, `VISION_MONTHLY_PAGES` | | Optional: Google Vision reading of scans |
| `OCR_RUN_MINUTES` | | Optional: OCR time limit |
| `SUPABASE_DB_URL` | | Optional: lets the container apply `schema.sql` on start when it changed (otherwise skipped) |

Copy the values from the current Vercel project settings.

## After the first deploy

- **Point the Supabase schedules at the new site**, otherwise they keep calling Vercel:
  `node tools/setup-schedules.js https://<coolify domain>` (from a team computer, with the root `.env`).
  Run it only once you switch over; both sites being called would run each update twice.
- Set `DASHBOARD_URL` to the Coolify domain.

## Dashboard accounts

From the application's **Terminal** in Coolify (it opens in `/app/frontend`):

```sh
node ../tools/add-user.js someone@company.com          # new account, random password printed once
node ../tools/add-user.js someuser "Password123"       # username account with a chosen password
```

Running it for an existing account resets its password. It uses the container's `SUPABASE_URL` and `SUPABASE_KEY`.

## Our own sign-in (for the private database, not live yet)

`frontend/src/lib/ownAuth.mjs` signs people in without Supabase Auth: accounts in `app_users`, sessions in an
httpOnly cookie (`app_sessions` keeps only its hash), 5 wrong passwords pause an account for 15 minutes. It is
off unless `AUTH_MODE=own` is set; until then Supabase Auth stays in charge. It needs `DATABASE_URL` (falls back
to `SUPABASE_DB_URL`). Do not switch it on alone: the pages still read Supabase directly, which needs a
Supabase sign-in.

```sh
node ../tools/import-auth-users.js            # list the Supabase accounts that would be copied
node ../tools/import-auth-users.js --apply    # copy them, same passwords
node ../tools/add-user.js someuser --own      # new account / password reset in our own sign-in
```

## Pages reading through this server (for the private database, testing)

`NEXT_PUBLIC_DATA_VIA_SERVER=1` (a **Build Variable**, so redeploy after setting it) makes the pages send their
database reads and writes to this server (`/api/data`) instead of straight to Supabase. The server checks the
sign-in and the same rules as the database (team members read; they may only add/edit hospitals and add/remove
Screened Tenders) and runs the query with its own database client (`DATA_BACKEND`). Sign-in, bid documents and
live updates still use Supabase for now. Leave it off on Vercel: every read would use Vercel's computing time.
Checked with `node --env-file=.env tools/check-data-route.mjs <site address>`.

## Programs outside the server (database stays private)

The private database is not opened to the internet. Programs that run elsewhere and used Supabase's keys (the office
PS-PhilGEPS log-in laptop `tools/ps-connect-host.js`, the GitHub fallback `tools/ps-connect-cloud.js`, and the
session save in `ps-philgeps-session.js`) go through the dashboard instead, with these settings in their `.env` /
GitHub secrets:

| Setting | Value |
| --- | --- |
| `DATA_BACKEND` | `dashboard` |
| `DASHBOARD_URL` | The Coolify site's address |
| `CRON_SECRET` | Same as the dashboard's |

They then reach only the tables the log-in needs (`app/api/data/route.js`, `PROGRAMS`): the saved session can be
written but never read back. Until switch day they keep `SUPABASE_URL` + `SUPABASE_KEY`. Don't point them at Vercel
this way: the log-in laptop asks every 3 seconds, which would use Vercel's computing time.

## Copying the data into the private database

The tables (not the bid documents) are copied from the application's **Terminal**, which reaches both Supabase and
the private database. The application needs these two settings; redeploy after adding them (a container only sees
settings it was started with):

| Setting | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Supabase → Connect → Session pooler connection string (read only here) |
| `DATABASE_URL` | The private database's **internal** URL (Coolify → the database → General) |

`DATABASE_URL` changes nothing else while `DATA_BACKEND` and `AUTH_MODE` are not set.

```sh
node ../tools/copy-to-private-db.mjs             # what would happen; changes nothing
node ../tools/copy-to-private-db.mjs --apply     # first copy; stops if the private database already has rows
node ../tools/copy-to-private-db.mjs --check     # compare both sides again, table by table
node ../tools/copy-to-private-db.mjs --replace   # fresh copy over the old one (switch day)
```

It adds stand-ins for the Supabase-only parts `schema.sql` mentions (`auth.jwt()`, `realtime`, `storage`, the API
roles), applies `schema.sql`, stops if any Supabase column is missing or has another type, copies every row from
one moment of Supabase in one transaction (nothing is kept if it fails), moves the id counters past the copied rows
and ends with a row count and fingerprint per table on both sides. Each copy reads about 50 MB from Supabase.
Supabase stays in use until switch day: a copy is a snapshot, so it is repeated with `--replace` right before.

## Bid documents on the server's disk (instead of Supabase Storage)

Reading documents out of Supabase Storage uses Supabase's monthly egress, so OCR stops when the month's budget is
used up (`lib/usageMeter.mjs`). Kept on this server's disk, they cost nothing to read.

1. **Persistent Storage** → add a **Volume**: destination path `/data/documents` (the image makes that folder,
   owned by the app, so the volume starts out writable). It keeps the files across redeploys.
2. Settings: `STORAGE_BACKEND=disk`, `DOCUMENTS_DIR=/data/documents`, and the **Build Variable**
   `NEXT_PUBLIC_DOCUMENTS_ON_SERVER=1` (the pages then open documents through this server). Redeploy.

Then every part that used `supabase.storage` (Sync's downloads, reading, OCR and its cache `_ocr/`, removing
files that aren't ours, View / Save / Source / ZIP in the pages) uses `/data/documents/<bucket>/<path>`, the same
paths as in Storage; reading them uses no egress. The pages get short-lived signed links from
`/api/stored-files` (signed-in team only). Files from before, still in Supabase Storage, are fetched from there once
when first needed and kept on disk (within the reading budget for the readers). Leave `STORAGE_BACKEND` off on
Vercel (with `FORWARD_API_TO` it doesn't need it: its `/api/` runs here).

**Switch it on only together with the Syncs moving to this server.** While Vercel (or the office PC) still runs the
Syncs, they save new documents in Supabase Storage, and this site would not find them on its disk. Checked with
`node --env-file=.env tools/check-disk-storage.mjs [site address]`.

## Moving the Syncs, reading and OCR to this server (switch-over)

Before: the Supabase schedules call Vercel (`philgeps-hourly-update`, `ps-philgeps-hourly-sync`,
`ps-philgeps-keepalive`), documents go to Supabase Storage and OCR runs on GitHub. After: everything runs here, the
documents are on this disk, and the Vercel site stays usable as a front that passes every `/api/` request on.
In this order, all on the same day:

1. **This app** (Coolify): the volume and three settings from "Bid documents on the server's disk" above. Redeploy.
   Files still in Supabase Storage keep working: each is fetched once when opened or read and then kept on disk
   (readers within the month's budget; a person opening a file always gets it). `STORAGE_FALLBACK=off` once
   everything is on disk.
2. **Vercel**: `FORWARD_API_TO=https://<this site>` and `NEXT_PUBLIC_DOCUMENTS_ON_SERVER=1`. Redeploy. Its Sync,
   Cancel, Read again, Connect, View/Save, Message Hospitals, ... now all run here (`next.config.mjs` rewrites).
3. **Schedules**, from a team computer: `node tools/setup-schedules.js https://<this site>` and
   `node tools/setup-keepalive.js https://<this site>`.
4. **GitHub**: disable the "Read scanned documents (OCR)" workflow (it can't reach this disk). Here the keep-alive
   starts `scripts/ocr-job.mjs` in the background at most hourly while scanned documents wait, and right after a
   reading finds new ones (`lib/ocrTrigger.mjs`); its output is in this app's logs. Before reading, it fetches the
   waiting scanned files of open tenders that are not on the disk yet from PS-PhilGEPS itself, with the saved session
   (`lib/sourceFetch.mjs`: right size only, never the log-in page, never during a Sync), so they need no Supabase
   download. By hand from the Terminal: `node scripts/fetch-waiting.mjs --dry-run`, then without `--dry-run`.
5. Check: a Sync from either site, View on a document from before and after the switch, the OCR count going down.

Undo: remove `FORWARD_API_TO` on Vercel and redeploy, point the schedules back at Vercel, enable the GitHub
workflow, remove `STORAGE_BACKEND` here and redeploy. Documents saved on this disk after the switch are then not in
Supabase Storage.

## Schedules (Coolify Scheduled Tasks, since 2026-11-28)

The hourly jobs are Coolify Scheduled Tasks of this app (not Supabase's pg_cron any more: `tools/setup-schedules.js`
and `tools/setup-keepalive.js` are only for going back). Container empty (the app's), "Run in a shell" ticked, times
in UTC (= Manila − 8 h). Each calls the app in its own container with its `CRON_SECRET`:

| Name | Schedule | Command |
| --- | --- | --- |
| `ps-keepalive` | `*/5 * * * *` | `node -e "fetch('http://127.0.0.1:3000/api/ps-keepalive',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(async r=>console.log(r.status,await r.text()))"` |
| `ps-sync` | `15 22,23,0-9 * * *` | `node -e "fetch('http://127.0.0.1:3000/api/ps-sync',{method:'POST',headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(async r=>console.log(r.status,await r.text()))"` |
| `philgeps-update` | `0 22,23,0-9 * * *` | `node -e "fetch('http://127.0.0.1:3000/api/philgeps-update',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(async r=>console.log(r.status,await r.text()))"` |

A task's Executions show the answer: `200 {"ok":true,"connected":true}`, `202 {"ok":true}`, ...

## How this differs from Vercel

- **No PhilGEPS fetching in the container**: like the Vercel copy, the image has no `scraper.js`/Chrome, so
  fetches stay with the office PC and the schedules. The Sync / scrape routes that only answer `localhost`
  (`lib/localRequest.js`) still refuse requests on the deployed site, as on Vercel.
- **OCR runs on the server**: `lib/psDocs.mjs` turns server-side OCR on whenever `VERCEL` is not set, because
  Vercel lacked the computing time. A Coolify server has no such limit, so scanned documents are read in the
  container (tesseract.js is in the image). The GitHub OCR workflow can keep running alongside it.
- Downloaded bid documents (`/api/documents`, local-only) are not part of the image.

## Building locally

```sh
docker build -t bidding-dashboard \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... .
docker run --rm -p 3000:3000 --env-file .env bidding-dashboard
```
