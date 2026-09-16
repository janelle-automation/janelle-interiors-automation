# Janelle Interiors — AI Workflow System

An intelligence layer over the studio's Gmail and Drive. It reads project activity, keeps one
live source of truth, drafts follow-ups, and writes a weekly report. The team keeps working in
Houzz Pro and Gmail; **nothing is auto-sent** — every outbound message is a draft a person approves.

> Full functional spec: [`docs/WORKFLOW-AND-FUNCTIONALITY.md`](docs/WORKFLOW-AND-FUNCTIONALITY.md)
> How it runs, end to end: [`docs/PROJECT-FLOW.md`](docs/PROJECT-FLOW.md)

## Stack

| Layer | Tech |
|---|---|
| Web | React + TypeScript + Vite + Tailwind |
| API | Node.js + Express + TypeScript |
| Data / Auth | Supabase (Postgres, Auth, Storage, Realtime, RLS) |
| Intelligence | Claude API |
| Sources | Gmail API · Google Drive API (read + draft only) |

## Monorepo layout

```
apps/
  web/        React command center (the studio-facing app)
  api/        Node API + background workers
packages/
  shared/     TypeScript types shared by web and api
supabase/
  migrations/ Ordered schema migrations (0001_baseline.sql …)
  seed.sql    Demo org, prompt library, sample rows
docs/         Functional spec + designed one-pager
```

## Getting started

### 1. Install
```bash
npm install
```

### 2. Environment
```bash
cp .env.example .env
```
The app runs immediately in **example mode** (sample data, a stand-in principal user) with no
configuration. To go live, fill in `.env`:

- **Supabase** — create a project, then paste the URL and keys.
- **Google OAuth** — create OAuth credentials (Gmail + Drive scopes) in Google Cloud Console.
- **Claude API** — an Anthropic API key (used from Milestone M2 onward).
- **Token key** — `openssl rand -base64 32` for `TOKEN_ENCRYPTION_KEY`.

### 3. Database
In the Supabase SQL editor (or `supabase db push`), run:
```
supabase/migrations/    # ordered migrations; add the next number to change the schema
supabase/seed.sql       # optional demo data
```

### 4. Run
```bash
npm run dev        # web + api together
npm run dev:web    # http://localhost:5173
npm run dev:api    # http://localhost:4000
```

Health check: `GET http://localhost:4000/api/health`

## Milestones

| | | Status |
|---|---|---|
| **M0** | Foundation — repo, web shell, API, schema, OAuth, auth + roles | ✅ built |
| **M1** | Tracking layer — Gmail/Drive ingestion, Claude extraction, live board, vendor/PO | ✅ built (activates with credentials) |
| **M2** | Prompt Studio — library + in-app Claude runner | ✅ built (activates with credentials) |
| **M3** | Follow-up engine + weekly report + scheduler | ✅ built (activates with credentials) |
| **M4** | Polish & handover | in progress |

## How it works once configured

- **Ingestion** (`services/ingest.ts`) reads recent Gmail + Drive PDFs, classifies and extracts
  structured data with Claude (`services/extract.ts`), links it to projects/vendors, and writes to Supabase.
- **Follow-up engine** (`services/followups.ts`) scans nightly for vendor silence, overdue client
  approvals, slipping dates and spec gaps, then creates a **Gmail draft** for each — never sent.
- **Weekly report** (`services/report.ts`) aggregates the week and writes a Claude-authored narrative.
- **Scheduler** (`services/scheduler.ts`) runs ingestion hourly, follow-ups at 02:00, the report Monday 07:00.
- These can be triggered on demand from the UI (Command Center, Follow-ups, Reports) or via
  `POST /api/ops/ingest`, `/api/follow-ups/run`, `/api/reports/generate`.

## Notes

- The web app opens in **example mode** so every screen is viewable before any credentials exist.
  Sample data is clearly labelled; it is never presented as the studio's real figures. Once Supabase
  and Claude keys are set, every page switches to live data automatically.
- API routes use a **request-scoped Supabase client** that forwards the caller's JWT, so
  row-level security is enforced for every query.
- The API boots even without credentials: data/auth routes return a clear `503 Backend not configured`
  and the scheduler stays idle until keys are present.
- The Google OAuth flow (consent URL, callback, encrypted token storage) is wired end to end; it
  activates once `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set and a user connects in Settings.
