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
