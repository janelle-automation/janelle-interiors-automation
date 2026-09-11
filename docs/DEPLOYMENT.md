# Deployment

The system is two deployables, not one:

| Piece        | What it is                        | Where it goes                          |
| ------------ | --------------------------------- | -------------------------------------- |
| `apps/web`   | Static Vite/React bundle          | Vercel                                 |
| `apps/api`   | Long-running Express + node-cron   | Railway / Render / Fly (a Node process) |

**Vercel cannot host `apps/api`.** It serves static assets and short-lived
serverless functions; `apps/api` calls `app.listen()` and runs a `node-cron`
scheduler that must stay alive between requests. Deploying only the web app is
what produces `404: NOT_FOUND` from Vercel's edge on every `/api/*` request —
the request never reaches our code.

---

## 1. Deploy the API

Any host that runs a persistent Node process works. Settings are the same
everywhere:

- **Root directory:** repository root (not `apps/api` — the build needs the
  `packages/shared` workspace)
- **Build command:** `npm install && npm run build --workspace packages/shared && npm run build --workspace apps/api`
- **Start command:** `npm run start --workspace apps/api`
- **Node version:** 20 or newer
- **Health check path:** `/api/health`

The server reads `PORT` from the platform automatically and binds `0.0.0.0`
when it is present, so no port configuration is needed.

### Environment variables

Set these on the API host. Do **not** upload `.env` — it is gitignored and
these hosts inject real environment variables.

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DB_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI      # must point at the deployed API, see below
GOOGLE_SCOPES
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
TOKEN_ENCRYPTION_KEY
CORS_ORIGINS             # the Vercel origin(s), see below
```

Omit `PORT`, `API_PORT` and `API_HOST` — the platform supplies `PORT` and the
other two are local-development overrides only.

---

## 2. Wire the two together

Three values must agree, or the app will build and still fail at runtime.

### `CORS_ORIGINS` on the API

Comma-separated list of the exact browser origins allowed to call the API.
Include the production domain and any preview domains you actually use:

```
CORS_ORIGINS=https://janelle-interiors-automation.vercel.app
```

If this is wrong the browser blocks every request with a CORS error, even
though the API is healthy.

### `VITE_API_BASE_URL` on Vercel

Set in **Vercel → Project Settings → Environment Variables**, then
**redeploy**. Vite inlines `import.meta.env` values into the bundle at *build*
time, so changing this variable has no effect until a new build runs.

```
VITE_API_BASE_URL=https://<your-api-host-domain>
```

No trailing slash. The client appends `/api/...` itself
(`apps/web/src/lib/api.ts`). If it is left unset the bundle falls back to
`http://localhost:4000`, which is dead for every real visitor.

Vercel also needs the Supabase project values. Set the **server-side names** — `vite.config.ts`
derives the client values from them, so there are no `VITE_`-prefixed copies to keep in step:

```
SUPABASE_URL
SUPABASE_ANON_KEY
```

Existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` variables still take precedence where they
are already set, so no deployment breaks on this change.

### `GOOGLE_REDIRECT_URI`

Must be the deployed API's callback URL, and must be registered verbatim in
the Google Cloud console as an authorised redirect URI:

```
GOOGLE_REDIRECT_URI=https://<your-api-host-domain>/api/auth/google/callback
```

---

## 3. Vercel project settings for `apps/web`

- **Root directory:** repository root
- **Build command:** `npm run build --workspace packages/shared && npm run build --workspace apps/web`
- **Output directory:** `apps/web/dist`

### Deployment protection

Preview deployments are private by default: visiting one while signed out
redirects to `vercel.com/login?next=/sso-api...` rather than serving the app.
To share preview links publicly, turn this off at **Project Settings →
Deployment Protection → Vercel Authentication**. Production deployments are
unaffected.

---

## 4. Verify

In order — each step depends on the one before it.

```bash
# 1. API is up
curl https://<your-api-host-domain>/api/health
# → {"ok":true,"service":"janelle-api",...}

# 2. Route exists and auth is enforced (401 is the CORRECT answer here;
#    404 means the API is not deployed where you think it is)
curl -o /dev/null -w "%{http_code}\n" \
  https://<your-api-host-domain>/api/dashboard/summary
# → 401
```

3. Open the Vercel site, sign in, and confirm the dashboard loads. If requests
   still fail, open DevTools → Network and check the **request URL**: if it
   points at `localhost` or at the Vercel domain instead of the API host,
   `VITE_API_BASE_URL` was not set at build time — set it and redeploy.

---

## Notes

### The scheduler runs on the API host

`startScheduler()` (`apps/api/src/services/scheduler.ts`) drives ingestion,
follow-ups and the weekly report via `node-cron`. It lives inside the API
process, so it only runs where the API runs. Hosts that sleep idle instances
on a free tier will pause it — use a tier that stays warm if the schedule
matters.

### Scaling past one instance

The scheduler has no cross-instance locking, so two or more API instances
would each fire the same cron jobs. Keep the API at a single instance, or move
the schedule to an external trigger before scaling out.
