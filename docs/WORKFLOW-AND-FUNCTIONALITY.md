# Janelle Interiors — AI Workflow System
## Workflow & Functionality Specification

**Version:** 1.0 (Design & Functional Spec)
**Stack:** React (frontend) · Node.js (backend/API + workers) · Supabase (Postgres, Auth, Storage, Realtime)
**Status:** Approved design direction — foundation for build

---

## 1. Purpose & Vision

Janelle Interiors runs its studio in **Houzz Pro**. That does not change. This system adds an
**intelligence layer on top of the studio's Gmail and Google Drive** that reads project activity,
understands it, and keeps a single source of truth continuously up to date — then does the chasing
and reporting that normally eats a coordinator's week.

The original brief delivered this through Google Sheets. This build replaces the spreadsheet with a
**purpose-built web application** — a calm, editorial "command center" for the studio — while keeping
the same core promise:

> The team keeps working in Houzz Pro and Gmail. The system reads, sorts, records, and drafts.
> **Nothing is auto-sent.** Every outbound message is a draft a human approves.

### What it delivers
- A **live tracking layer** that never goes stale, replacing manual spreadsheet upkeep.
- An **AI prompt studio** for design, procurement, client communication, and admin — run in-app, no copy-paste.
- A **follow-up engine** that turns vendor silence, overdue approvals, and slipping dates into ready-to-send Gmail drafts.
- A **Monday weekly report** summarizing the whole studio at a glance.

### Design principles
1. **Human-in-the-loop.** The AI drafts and records. People decide and send.
2. **Read, don't disrupt.** No write-back to Houzz Pro. The studio's existing tools stay authoritative.
3. **One source of truth.** Every project, vendor, PO, and deadline lives in one place, updated in real time.
4. **Revocable & least-privilege.** Google access is scoped and can be withdrawn at any moment.

---

## 2. System at a Glance

```
   ┌─────────────────────┐        ┌──────────────────────────┐        ┌────────────────────────┐
   │   SOURCES (Google)  │        │   INTELLIGENCE LAYER      │        │   COMMAND CENTER (App) │
   │                     │        │   (Node.js + Claude AI)   │        │   (React + Supabase)   │
   │  • Gmail            │──read─▶│  1. Ingest & classify     │──write▶│  • Live tracking board │
   │  • Google Drive     │        │  2. Extract structured    │        │  • Projects pipeline   │
   │    (PDF quotes,     │        │     data (project, vendor,│        │  • Vendor / PO tracker │
   │     order confirms) │        │     item, PO#, dates...)  │        │  • Awaiting-client     │
   │                     │        │  3. Link to entities      │        │  • Spec-gap tracker    │
   │                     │◀draft──│  4. Follow-up engine      │        │  • Prompt Studio       │
   │  • Gmail Drafts     │        │  5. Weekly report         │        │  • Follow-up inbox     │
   └─────────────────────┘        └──────────────────────────┘        │  • Weekly report       │
                                                                       └────────────────────────┘
                                        ▲                                          │
                                        └───────── Supabase (Postgres + Realtime) ─┘
```

**Data flows one way in, one way out:**
- **In:** Gmail + Drive → parsed → structured records in Supabase → pushed live to the dashboard.
- **Out:** the app creates **Gmail drafts** for a person to review and send. Nothing else leaves the system.

---

## 3. Architecture

### 3.1 Frontend — React
- **React + TypeScript**, built with **Vite**.
- **Tailwind CSS** + a bespoke component library for the studio's visual identity.
- **TanStack Query** for server state; **Supabase JS client** for auth + realtime subscriptions.
- **Realtime** dashboard: rows update the instant the backend writes them — the "live sheet" feel.
- Light + dark themes; fully responsive (desktop-first, tablet-friendly).

### 3.2 Backend — Node.js
A Node service (Express or Fastify) plus background workers. Responsibilities:
- **Google OAuth** — connect each user's Gmail + Drive with least-privilege scopes.
- **Ingestion workers** — poll/receive new email and Drive changes, download PDFs.
- **AI extraction** — call the **Claude API** to turn unstructured mail/PDFs into structured records.
- **Entity resolution** — match extracted data to the right project and vendor.
- **Follow-up engine** — scheduled nightly job that applies the studio's rules and drafts nudges.
- **Draft writer** — create Gmail drafts via the Gmail API (never send).
- **Report generator** — assemble and write the Monday weekly report.
- **Prompt runner** — execute Prompt Studio prompts against Claude with project context.

### 3.3 Supabase
- **Postgres** — the single source of truth (schema in §8).
- **Auth** — team sign-in (Google SSO), tied to roles.
- **Storage** — cached copies of parsed PDFs and generated report snapshots.
- **Realtime** — live table/board updates in the UI.
- **Row Level Security (RLS)** — per-role, per-project access enforced at the database.
- **Edge Functions / scheduled triggers** — optional home for the nightly + Monday jobs.

### 3.4 External services
| Service | Use | Direction |
|---|---|---|
| Gmail API | Read project mail; create drafts | Read + draft (never send) |
| Google Drive API | List/read files, fetch PDF quotes & order confirmations | Read-only |
| Claude API | Extraction, drafting, prompt runs | — |
| Houzz Pro | Source of truth for the studio; read via its notification emails + CSV import | Read-only (no write-back) |

---

## 4. User Roles & Permissions

The studio has 4–5 people. Roles map to Supabase RLS policies.

| Role | Typical person | Can see / do |
|---|---|---|
| **Principal / Owner** | Janelle | Everything: all projects, reports, settings, integrations, team management |
| **Designer** | Lead/junior designers | Assigned projects, specs, Prompt Studio (design + client), documents |
| **Procurement / FF&E** | Buyer | Vendors, POs, order tracking, procurement prompts, spec gaps |
| **Project Coordinator / Admin** | Coordinator | All tracking, follow-up inbox, drafts, reports; no billing/settings |
| **Assistant / Junior** | Support | Read access + limited task actions on assigned projects |

Permissions are **per role and per project assignment**. Google access is granted per user and revocable at any time from Settings → Integrations.

---

## 5. Core Modules (Functionality)

### 5.1 Dashboard — Command Center
The landing view. At-a-glance state of the whole studio:
- Active projects by stage (pipeline health).
- What needs a human today: drafts awaiting review, overdue approvals, at-risk dates.
- Recent activity feed (new quotes parsed, POs confirmed, emails linked).
- Quick stats: open POs, awaiting-client count, spec gaps, installs this week.

### 5.2 Projects & Pipeline
- Each project: client, stage, status, key dates, budget, assigned team, linked emails/docs/POs.
- **Pipeline stages:** `Lead → Concept → Spec → Approval → PO → Production → Shipping → Install → Complete`
  *(final stage list confirmed with the studio — see Open Questions.)*
- **Two views:** a **Kanban board** (drag between stages) and a **live table** (the "tracking sheet").
- Timeline per project: every parsed email, document, PO, and follow-up in chronological order.

### 5.3 Vendor & PO Tracker
- Vendor directory with contacts and history.
- **Purchase orders:** PO number, vendor, project, line items, amount, status, order date, ETA, received date.
- PO status: `Draft → Placed → Confirmed → In Production → Shipped → Received`.
- Auto-populated from parsed quotes and order confirmations; editable by procurement.
- Flags: overdue ETAs, vendors gone silent, price mismatches vs. quote.

### 5.4 Inbox Intelligence (Email layer)
- Reads project-relevant Gmail; classifies each message (vendor quote, order confirm, client approval, Houzz notification, general).
- Extracts structured data and **links the email to the right project/vendor/PO**.
- A triage view shows what was read, what it became, and anything it could not confidently classify (for a human to confirm).

### 5.5 Document Intelligence (Drive / PDF)
- Watches designated Drive folders.
- Parses **PDF quotes and order confirmations**: vendor, items, quantities, prices, PO number, dates.
- Stores the parsed result against the project and PO; keeps a cached copy in Supabase Storage.
- Surfaces low-confidence extractions for review rather than guessing silently.

### 5.6 Prompt Studio (Phase 1 in the brief)
A library of up to **20 curated prompts**, built from the studio's own spec sheets, proposals, and emails, across four categories:

| Category | Examples |
|---|---|
| **Design** | Concept narrative, room scheme, material/finish spec write-up |
| **Procurement / FF&E** | Spec-sheet generation, PO draft, vendor/option comparison |
| **Client communication** | Proposal copy, approval request, status update email |
| **Admin** | Meeting notes → action items, status summary, checklist |

**Answering the brief's open question ("where do these prompts run?"):** they run **inside the app**,
powered by the Claude API, pre-filled with the selected project's real context. No copy-paste into an
external chatbot. Each run is logged, and outputs can be saved to the project or turned into a Gmail draft.

### 5.7 Follow-up Engine (Phase 3)
Runs **nightly**. Applies the studio's rules to find things that have gone quiet or overdue:
- Vendor silence beyond the threshold (default configurable, e.g. 3 business days).
- Client approvals overdue beyond the threshold.
- Slipping / past-due delivery or install dates.
- Spec gaps blocking a stage.

For each, it **drafts an appropriate message** and:
1. Creates a **Gmail draft** in the right person's mailbox (never sent).
2. Creates a task card in the **Follow-up Inbox** with one-click "Open draft in Gmail."
3. Logs it so the same nudge is not raised twice.

### 5.8 Follow-up Inbox
A dedicated review queue: every AI-drafted nudge, grouped by project and urgency. A person reviews,
edits in Gmail, sends, and marks done. This is the human-in-the-loop gate.

### 5.9 Awaiting-Client & Spec-Gap Trackers
- **Awaiting client:** every item blocked on a client decision, with how long it has waited.
- **Spec gaps:** items missing required fields (dimensions, finish, SKU, lead time) before they can be ordered.

### 5.10 Reports (Phase 3)
Generated every **Monday** (and on demand). Delivered in-app, with an optional emailed/draft copy.
Contents — **answering the brief's open question on what the weekly report includes**:

1. **Pipeline movement** — projects that changed stage this week, and current count per stage.
2. **Procurement** — POs placed, confirmed, shipped, and received this week; total committed spend.
3. **Overdue vendor follow-ups** — who is silent and for how long.
4. **Awaiting client** — approvals outstanding and their age.
5. **At-risk dates** — slipping or past-due deliveries and installs; installs coming up next week.
6. **Spec gaps** — items still missing information before they can be ordered.
7. **Drafts pending your review** — follow-ups waiting to be sent.
8. **Budget snapshot** — committed vs. remaining, where budget data is available.

### 5.11 Settings & Integrations
- Connect / disconnect Google (Gmail + Drive) per user — **revocable any time**.
- Configure stage names, follow-up thresholds, report day/time, watched Drive folders.
- Team & roles management.
- Houzz Pro CSV import for the initial project list.
- Full audit log of what the system read, extracted, and drafted.

---

## 6. End-to-End Workflows

### 6.1 Ingestion pipeline (continuous)
```
New email / Drive file
   │
   ▼
[1] Fetch (Gmail push via Pub/Sub or poll; Drive change feed) → download PDFs
   │
   ▼
[2] Classify: is this project-relevant? what type? (vendor quote, PO confirm, client, Houzz, other)
   │
   ▼
[3] Extract with Claude → structured JSON (project, vendor, item, qty, price, PO#, dates)
   │
   ▼
[4] Resolve entities → match to existing project / vendor / PO (or flag as new / uncertain)
   │
   ▼
[5] Write to Supabase → Realtime pushes the update live to the dashboard
   │
   ▼
Low-confidence? → surface in triage for a human to confirm.
```

### 6.2 Follow-up pipeline (nightly)
```
Nightly job
   │
   ▼
Scan rules: vendor silence > N days · client approval overdue · date slipping · spec gap blocking
   │
   ▼
For each trigger → Claude drafts the message with project + contact context
   │
   ▼
Create Gmail DRAFT (never sent) + task card in Follow-up Inbox + log
   │
   ▼
Person reviews → edits → sends → marks done
```

### 6.3 Weekly report (Monday)
```
Monday job → aggregate the week's data → Claude writes the narrative summary
   → publish in-app report + optional Gmail draft copy → notify the team
```

---

## 7. UI / UX Direction

A **calm, editorial, premium** interface that feels like it belongs to an interior design studio —
not a generic SaaS dashboard.

- **Aesthetic:** warm neutrals, refined serif/sans pairing, generous whitespace, tactile cards, subtle depth.
- **Signature views:**
  - **Command Center** dashboard with a clear "what needs me today" focus.
  - **Live tracking board** — the spreadsheet reborn as a beautiful, realtime, filterable table.
  - **Pipeline Kanban** — drag projects across stages.
  - **Follow-up Inbox** — a triage queue like a well-designed mail client.
  - **Prompt Studio** — a focused, document-like composing surface.
- **Motion:** purposeful and quiet — realtime rows fade in, status changes animate softly.
- **Themes:** light and dark, both first-class.
- **Accessibility:** WCAG AA contrast, keyboard navigation, screen-reader labels.

---

## 8. Data Model (Supabase / Postgres)

Core tables (simplified):

| Table | Key fields |
|---|---|
| `organizations` | id, name, settings |
| `users` / `profiles` | id, name, email, role, org_id |
| `projects` | id, name, client_name, stage, status, budget, start_date, target_install, assigned_to |
| `vendors` | id, name, contacts, category, notes |
| `purchase_orders` | id, po_number, vendor_id, project_id, amount, status, order_date, eta, received_date |
| `line_items` | id, po_id, description, sku, qty, unit_price |
| `documents` | id, project_id, drive_file_id, type (quote/po/confirm), parsed_json, storage_path, confidence |
| `emails` | id, gmail_id, thread_id, from, to, subject, snippet, project_id, class, extracted_json |
| `follow_ups` | id, type, project_id, vendor_id, target, due_date, status, draft_id |
| `drafts` | id, gmail_draft_id, follow_up_id, body_preview |
| `spec_gaps` | id, project_id, item, missing_fields |
| `reports` | id, week_of, generated_json, storage_path |
| `prompts` | id, title, category, template, variables |
| `prompt_runs` | id, prompt_id, project_id, user_id, input, output, created_at |
| `integrations` | id, user_id, provider, encrypted_tokens, scopes, status |
| `activity_log` | id, actor, action, entity, meta, created_at |

All tables carry `org_id` and are protected by **RLS** so users only see their organization and permitted projects.

---

## 9. Security & Trust

- **Least-privilege OAuth** — request only the Gmail + Drive scopes needed; read + draft, never send-on-behalf beyond drafts.
- **Revocable access** — disconnect Google per user instantly; tokens encrypted at rest.
- **No write-back to Houzz Pro** — the studio's system stays authoritative and untouched.
- **Human-in-the-loop** — every outbound message is a draft; the system never sends.
- **Audit log** — a record of everything read, extracted, and drafted.
- **RLS everywhere** — access enforced at the database, not just the UI.

---

## 10. Mapping to the Brief's Three Phases

| Brief phase | This build |
|---|---|
| **Phase 1 — Prompt system** | §5.6 Prompt Studio — up to 20 prompts, run in-app on real project context |
| **Phase 2 — Tracking layer** | §5.1–5.5, 5.9 — ingestion pipeline + live tracking board, vendor/PO tracker, awaiting-client, spec gaps |
| **Phase 3 — Follow-up + reporting** | §5.7, 5.8, 5.10 — nightly nudges as Gmail drafts + Monday weekly report |

### Scope guardrails (from the brief)
- **Included:** up to 20 prompts + playbook · Gmail/Drive tracking layer + live board · follow-up nudges + weekly report · one revision round per phase · handover docs + walkthrough.
- **Not included:** changes or write-back to Houzz Pro · integrations beyond Google Workspace · custom mobile app · ongoing support after handover · AI subscription/usage costs.

---

## 11. Delivery Plan

| Milestone | Outcome |
|---|---|
| **M0 — Foundation** | Repo, React app shell, Node API, Supabase schema, Google OAuth, auth + roles |
| **M1 — Tracking layer (Phase 2)** | Ingestion pipeline, extraction, live board, vendor/PO tracker, projects pipeline |
| **M2 — Prompt Studio (Phase 1)** | Prompt library, in-app runner, save-to-project / draft |
| **M3 — Follow-up + reports (Phase 3)** | Nightly engine, Gmail drafts, Follow-up Inbox, Monday report |
| **M4 — Polish & handover** | UI refinement, audit log, docs, walkthrough |

---

## 12. Open Questions (to confirm with the studio)

These shape the build and carry over from the original brief:

1. **Email setup** — shared inbox (`projects@`, `info@`) or each member from their own address?
2. **Houzz Pro export** — can the project list be exported as CSV? One sample of each notification email (new lead, client comment, invoice paid) would help tune extraction.
3. **Pipeline stages** — confirm the exact stage list the studio thinks in.
4. **"Stuck" thresholds** — how many days of vendor silence before a nudge? Same for client approvals?
5. **Team & roles** — the 4–5 people and the access each role should have.

---

*Prepared as the functional foundation for the Janelle Interiors AI Workflow System build (React · Node.js · Supabase).*
