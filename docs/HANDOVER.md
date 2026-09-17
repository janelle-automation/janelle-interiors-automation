# Janelle Interiors AI Workflow System — Handover

Everything needed to set up, run, operate, and hand off the system. Pair this with
[`WORKFLOW-AND-FUNCTIONALITY.md`](WORKFLOW-AND-FUNCTIONALITY.md) for the functional design.

---

## 1. What it is

An intelligence layer over the studio's Gmail and Drive. It reads project activity, keeps one live
source of truth in a web app, drafts follow-ups, and writes a Monday report. The studio keeps working
in Houzz Pro and Gmail. **Nothing is auto-sent** — every outbound message is a Gmail draft a person approves.

---

## 2. Architecture

| Layer | Tech | Location |
|---|---|---|
| Web app | React + TypeScript + Vite + Tailwind | `apps/web` |
| API + workers | Node.js + Express + TypeScript | `apps/api` |
| Data / auth | Supabase (Postgres, Auth, Storage, Realtime, RLS) | `supabase/` |
| Intelligence | Claude API (`@anthropic-ai/sdk`) | `apps/api/src/services` |
| Shared types | TypeScript | `packages/shared` |

The web app runs in **example mode** until credentials exist, so every screen is viewable up front.
The API boots without credentials too: data routes return `503 Backend not configured` and the
scheduler stays idle until keys are present.

---

## 3. One-time setup

### Prerequisites
- Node.js 20+ and npm 10+
- A Supabase project
- Google Cloud OAuth credentials (Gmail + Drive)
- An Anthropic (Claude) API key

### Install
```bash
npm install
cp .env.example .env
```

### Fill `.env`
| Variable | Where to get it |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `SUPABASE_DB_URL` | Supabase → Settings → Database → Connection string (Direct) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | same as the Supabase values above |

Also set `VITE_*` values — these are the only Supabase values exposed to the browser (public anon key only).

### Create the database
Run the schema, then the optional demo seed:
```bash
npm run db:apply        # schema only  (needs SUPABASE_DB_URL)
npm run db:apply:seed   # schema + demo org, vendors, projects, prompts
```
Or paste `supabase/schema.sql` (then `supabase/seed.sql`) into the Supabase SQL editor.

### Load the prompt library
The studio's own prompts (`docs/reference/*.txt`, written up in
`scripts/prompt-library.mjs`) go in with:
```bash
npm run seed-prompts          # every organization
npm run seed-prompts -- --dry # show what would change first
```
This writes rows, not schema, so it goes through PostgREST with the service-role
key and works even while `db:apply` is blocked. It is idempotent and matches on
(org, title): edit `scripts/prompt-library.mjs` and re-run to revise a prompt.

### Rendering presentation boards
Five of the library prompts also draw a picture — the 644 Adirondack elevation +
moodboard board, a room rendering, a moodboard page, a materials page and a
snapshot retouch. Claude does not make images, so this needs a second provider:

```bash
GEMINI_API_KEY=...                        # aistudio.google.com/apikey
GEMINI_IMAGE_MODEL=gemini-3-pro-image     # optional; Flash is cheaper for iterating
```

A studio may instead set its own key from Settings, which is stored encrypted in
`organizations.settings` exactly as the Anthropic key is. Without a key the
Render button never appears and the endpoint answers 503 — everything else keeps
working.

The board is drawn from the reference images attached in the run modal, which is
what makes "match the approved house template" enforceable: the approved board
goes in as a reference on every render. Output lands in the same private uploads
bucket as Jenny's attachments, and each render is priced per image onto the usual
AI spend report (`IMAGE_MODELS` in `packages/shared`).

### Google OAuth setup
1. Enable the **Gmail API** and **Google Drive API** in Google Cloud.
2. Create an OAuth 2.0 Client (Web application).
3. Add the redirect URI: `http://localhost:4055/api/auth/google/callback` (match `GOOGLE_REDIRECT_URI`).
4. Scopes used (least privilege): `gmail.readonly`, `gmail.compose` (drafts only — never sends), `drive.readonly`.

### Create the first user
Sign in through the app (Google SSO via Supabase Auth), then in Supabase set that user's `profiles`
row `role` to `principal` and `org_id` to the seeded organization. The principal's connected Google
account is the ingestion source.

---

## 4. Running

### What Claude costs, and keeping it down
`npm run ai-usage` (or `-- 60` for the recent ones) prints spend per feature and
whether the prompt cache is being hit. Two things keep the bill down, and both
are easy to undo by accident:

- **The tool block carries the cache breakpoint** (`CACHED_TOOLS`). It is the
  largest stable part of every request.
- **The system prompt is split in two**: `systemPrompt()` is stable and cached,
  `situation()` carries the page, the live figures and anything pending, and is
  appended *after* the breakpoint. Moving a volatile value back into the stable
  half silently doubles the bill — it invalidates the cache on every question.

Measured on the assistant: $0.0096 a turn before, $0.0050 with the tools cached,
$0.0025 with both. `AI_TOKEN_BUDGET` (default 5000) additionally clamps output
so one call cannot run away; raise it if long documents come back truncated.

```bash
npm run dev        # web (http://localhost:5173) + api (http://localhost:4055) together
npm run dev:web    # web only
npm run dev:api    # api only
npm run build      # type-check + build all packages
```
Health check: `GET http://localhost:4055/api/health` — reports which integrations are configured.

> Ports are configurable in `.env` (`API_PORT`, and the web dev port in `apps/web/vite.config.ts`).

---

## 5. Operations runbook

Three background jobs run automatically (`apps/api/src/services/scheduler.ts`), and each can be
triggered on demand from the UI or the API:

| Job | Schedule | What it does | Manual trigger |
|---|---|---|---|
| **Ingest** | hourly | Reads recent Gmail + Drive PDFs, extracts with Claude, links to projects/vendors, writes to Supabase | Command Center → "Read Gmail & Drive", or `POST /api/ops/ingest` |
| **Follow-ups** | nightly 02:00 | Finds vendor silence, overdue approvals, slipping dates, spec gaps → creates a Gmail draft for each | Follow-ups → "Run follow-ups now", or `POST /api/follow-ups/run` |
| **Weekly report** | Monday 07:00 | Aggregates the week, writes a Claude narrative | Reports → "Generate now", or `POST /api/reports/generate` |

Thresholds (vendor-silence days, client-approval days) live in the organization's `settings` JSON and
are shown in Settings → Studio rules.

---

## 6. Security

- **Least-privilege OAuth** — read Gmail/Drive and create drafts; the system never sends.
- **Revocable** — disconnect Google per user in Settings; tokens are AES-256-GCM encrypted at rest.
- **RLS everywhere** — every table is org-scoped; API requests run under the caller's JWT so the
  database enforces access, not just the UI.
- **Service-role key** stays server-side only; it is never sent to the browser.
- **Audit log** — every ingest, follow-up run, report, and draft is recorded (Audit Log page).

---

## 7. First-run walkthrough

1. **Sign in** with the studio Google account; set the profile to `principal` in Supabase.
2. **Settings → Connect Google.** Approve the Gmail + Drive scopes. Status turns to "connected".
3. **Command Center → "Read Gmail & Drive".** The ingest job reads recent mail and PDFs; watch the
   Inbox Intelligence and Documents pages fill in, and the dashboard counts update.
4. **Follow-ups → "Run follow-ups now".** The engine raises nudges and writes Gmail drafts. Open each
   in Gmail, edit, and send. Mark items Done or Dismiss as you go.
5. **Prompt Studio.** Open a prompt, fill its fields, optionally pick a project to save the run to,
   and Run. Copy the output or turn it into a Gmail draft.
6. **Reports → "Generate now".** A Monday-style summary is written and shown with the week's figures.
7. **Audit Log.** Confirm every action the system took is recorded.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EADDRINUSE` on start | Another process holds the port. Change `API_PORT` or free the port. |
| Health shows `supabase: not_configured` | `.env` keys blank or comments on the value line. Values must be bare (no inline `#`). |
| Data routes return `503 Backend not configured` | Supabase keys not set — add them to `.env` and restart. |
| Prompt run returns 503 | `ANTHROPIC_API_KEY` not set. |
| "Connect Google in Settings to create drafts" | The acting user has no connected Google integration. |
| Ingest finds nothing | Check the source user is `principal` with Google connected, and that mail matches the query window. |

---

## 9. What's next (beyond this handover)

- Realtime board updates via Supabase Realtime subscriptions.
- Editable studio settings (stages, thresholds, watched Drive folders) from the UI.
- Deeper Gmail draft deep-linking to the exact draft.
- Per-project email/document timelines and richer entity resolution.
