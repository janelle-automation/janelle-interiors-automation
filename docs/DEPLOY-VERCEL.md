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
| `/api/ops/cron/ingest` | not registered — see below |

**On the Hobby plan Vercel runs each cron job once a day and allows two of
them**, so the two above use the quota and continuous ingestion is not
possible. Until that changes, new mail is read when someone presses **Read
Gmail & Drive** on the Dashboard.

To get automatic ingestion back, either:

- **Move the API to an always-on host** (Railway, Render, Fly.io, a VPS).
  Run `npm run build && npm start -w apps/api` there, keep the web app on
  Vercel, and set `VITE_API_BASE_URL` to the API's URL and `CORS_ORIGINS` to
  the web app's. The existing node-cron scheduler then runs as designed.
- **Or call `/api/ops/cron/ingest` from an external scheduler**
  (cron-job.org, GitHub Actions, Upstash QStash) as often as you want, with
  the header `Authorization: Bearer $CRON_SECRET`.

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
