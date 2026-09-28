# Deploying to Vercel

One Vercel project serves both halves of the app:

| Path | Served by |
| --- | --- |
| `/`, `/projects`, `/drafts`, … | the built React app in `apps/web/dist` |
| `/api/*` | the Express API, as a single serverless function |

Because both live on one domain, the browser makes same-origin requests and
there is no CORS to configure.

## How it is wired

- **`vercel.json`** sets the build command, points the static output at
  `apps/web/dist`, rewrites unknown paths to `index.html` for the React
  router, and registers the cron jobs.
- **`api/[...path].mjs`** is the serverless function. Vercel scans the
  top-level `api/` directory, and the catch-all filename means every
  `/api/*` request reaches it with the original path intact.
- **`apps/api/src/app.ts`** holds the Express app with no server attached.
  `apps/api/src/index.ts` adds `listen()` and the node-cron scheduler for
  local and self-hosted runs; the serverless function imports the app only.

## Environment variables

Set these in **Project → Settings → Environment Variables** (Production and
Preview). Names match `.env.example`.

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | |
| `SUPABASE_ANON_KEY` | |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never expose to the browser. |
| `GOOGLE_CLIENT_ID` | |
| `GOOGLE_CLIENT_SECRET` | |
| `GOOGLE_REDIRECT_URI` | `https://YOUR-DOMAIN/api/auth/google/callback` |
| `GOOGLE_SCOPES` | Same value as local |
| `ANTHROPIC_API_KEY` | |
| `ANTHROPIC_MODEL` | `claude-opus-5` |
| `TOKEN_ENCRYPTION_KEY` | Must be the **same** key used locally, or stored Google tokens cannot be decrypted |
| `CRON_SECRET` | `openssl rand -hex 32`. Cron endpoints refuse everything while unset |
| `CORS_ORIGINS` | `https://YOUR-DOMAIN` |
| `VITE_SUPABASE_URL` | Build-time, public |
| `VITE_SUPABASE_ANON_KEY` | Build-time, public |
| `VITE_API_BASE_URL` | **Leave unset.** The app then calls `/api/*` on its own origin |

`SUPABASE_DB_URL` is only needed for `npm run db:apply:seed`, which is run
from a developer machine, not from Vercel.

## After the first deploy

1. Add the deployed callback URL to the Google Cloud OAuth client's
   **Authorized redirect URIs**: `https://YOUR-DOMAIN/api/auth/google/callback`.
2. Add `https://YOUR-DOMAIN` to Supabase → Authentication → URL Configuration
   (Site URL and Redirect URLs), so email and Google sign-in return correctly.
3. Sign in, then reconnect Gmail and Drive from Settings. Tokens are stored
   per user and per redirect URI.
4. Check `https://YOUR-DOMAIN/api/health` — it reports which integrations the
   server can see.

## Scheduled work

Self-hosted, `services/scheduler.ts` polls Gmail and Drive **every 5 seconds**
and runs follow-ups and the weekly report on timers. A serverless function has
no long-running process, so on Vercel that scheduler never starts. Vercel Cron
calls these endpoints instead, authenticated with `CRON_SECRET`:

| Endpoint | Registered schedule |
| --- | --- |
| `/api/ops/cron/follow-ups` | `0 2 * * *` — nightly |
| `/api/ops/cron/report` | `0 7 * * 1` — Monday morning |
| `/api/ops/cron/ingest` | every minute, from Supabase pg_cron — see below |
| `/api/ops/cron/digest` | `5 7 * * *` — every morning |
| `/api/ops/cron/media` | every 2 minutes, from Supabase pg_cron — see below |
| `/api/ops/cron/tasks` | every 5 minutes, from Supabase pg_cron — see below |
| `/api/ops/cron/midday-reminder` | polled every 15 minutes, from Supabase pg_cron — see below |

> **Never register a cron more often than once a day on Hobby.** Vercel rejects
> the whole deployment, after a build that passed, with only "Deployment
> failed" on the PR. That is what happened to PR #11: the video sweep went in
> at `*/5 * * * *`. Anything that needs to run more often goes through an
> external scheduler, as below.

**On the Hobby plan Vercel runs each cron job at most once a day**, so
everything more frequent is scheduled by **Supabase** instead: `pg_cron`
fires the job and `pg_net` calls the endpoint with the bearer secret. Nothing
is set in Vercel's cron settings or GitHub for these.

| Supabase job | Schedule | Migration |
| --- | --- | --- |
| `task-review` → `/tasks` | `*/5 * * * *` | `0021_task_review_cron.sql` |
| `email-ingest` → `/ingest` | `* * * * *` | `0022_ingest_and_media_cron.sql` |
| `media-sweep` → `/media` | `*/2 * * * *` | `0022_ingest_and_media_cron.sql` |
| `midday-reminder` → `/midday-reminder` | `*/15 * * * *` | `0024_midday_reminder_cron.sql` |

Setup, once, in the Supabase SQL editor: store the address and secret in
Vault (`app_url`, and `cron_secret` — the same value as `CRON_SECRET` on
Vercel; 0021's header has the two lines), then run 0021, 0022 and 0024.
Recent runs are in `cron.job_run_details`, and each call's HTTP status in
`net._http_response`. A 401 there means the Vault secret and Vercel's differ.

**`/api/ops/cron/ingest`** is called every minute, but reads each studio only
as often as it chose in Settings → Reading email (the last start is kept in
`settings.ingest_ran_at`), and never a studio set to "Only when I ask". Most
calls therefore do nothing. Add `?force=1` to read every studio at once.

**`/api/ops/cron/media`** finishes video clips whose tab was closed while they
rendered. Without it, a clip nobody is watching when it finishes is written
off after ten minutes.

**`/api/ops/cron/tasks`** closes the tasks that the mail since they were
raised shows are finished. It is called every five minutes but reviews each
studio only as often as the admin chose in Settings → Reading email → "Close
finished tasks" (default hourly; Off skips it; last start in
`settings.task_review_ran_at`). Only a task with mail it has not been checked
against costs a Claude call. `?force=1` reviews every studio now.

**`/api/ops/cron/midday-reminder`** emails the studio's midday task
reminder: one message per teammate with open work, plus one to the owner
breaking the whole studio down by person. Polled every 15 minutes, but only
actually sends in the noon-Pacific hour, and only once per studio per day
(last start in `settings.midday_reminder_ran_at`) — the wall-clock-hour gate
is what keeps this at noon Pacific through the PST/PDT change without
editing the schedule. Real sends, not drafts (see `sendMessage` in
`services/gmail.ts`); every recipient is currently the studio's own
`systems@` mailbox rather than the real person, while the content is being
checked (`TEST_RECIPIENT` in `services/middayReminder.ts`). `?force=1` sends
now regardless of the hour or the last send.

**The Supabase schedules are only the fastest pace.** How often each job
really runs for a studio is the admin's setting, read on every call, so a
change in Settings takes effect on the next call with no SQL and no deploy.

Self-hosted, the node-cron scheduler runs all four and the Supabase jobs
should be unscheduled (`select cron.unschedule('email-ingest')` and so on),
or both will do the work.

A single function invocation is capped at 60 seconds (`maxDuration` in
`vercel.json`), so a very large first ingestion may need several runs. Each
run is guarded against overlapping with another, and skips work it has
already done.

## Testing the function locally

`npm run dev` still runs the normal two-process setup. To exercise the
serverless entry exactly as Vercel will:

```bash
npm run build
npx vercel dev
```
