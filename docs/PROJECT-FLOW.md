# Janelle Interiors — Project Flow

How the system actually runs, end to end, as built. Every arrow below is a code path that
exists today; where a flow depends on a setting or a credential, the condition is named.

**Companion documents**

| Document | Answers |
|---|---|
| [`WORKFLOW-AND-FUNCTIONALITY.md`](WORKFLOW-AND-FUNCTIONALITY.md) | What the system is *meant* to do (the approved design spec) |
| **`PROJECT-FLOW.md`** (this file) | What happens at runtime, in what order, and where it lives |
| [`HANDOVER.md`](HANDOVER.md) | Setup, operation, and handing it over |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) · [`DEPLOY-VERCEL.md`](DEPLOY-VERCEL.md) | Getting it hosted |

---

## 1. The shape of the system

```
  ┌──────────────┐        ┌───────────────────────────────┐        ┌──────────────────┐
  │   Browser    │ HTTPS  │   API — Express (apps/api)     │        │  Supabase        │
  │ React + Vite │───────▶│                                │───────▶│  Postgres · Auth │
  │ (apps/web)   │◀───────│  routes/   thin HTTP layer     │◀───────│  Storage · RLS   │
  └──────────────┘        │  services/ the actual work     │        └──────────────────┘
         │                │  lib/      creds, cache, perms │                 ▲
         │  supabase-js   └───────────────────────────────┘                  │
         │  (auth + realtime)         │            │                         │
         └────────────────────────────┼────────────┼─────────────────────────┘
                                      │            │
                             ┌────────▼───┐   ┌────▼────────┐
                             │ Google     │   │ Claude API  │
                             │ Gmail read │   │ classify ·  │
                             │ Drive read │   │ extract ·   │
                             └────────────┘   │ draft · ask │
                                              └─────────────┘
```

**Two deployables, one repo.** `apps/web` is a static bundle; `apps/api` is a Node service.
`packages/shared` is compiled first and imported by both, so a type, a role, a permission
default or a price table is defined once.

**Two ways the API runs.** The difference matters, because the scheduling story changes:

| | Local / self-hosted | Vercel |
|---|---|---|
| Entry | `apps/api/src/index.ts` — `app.listen()` | `api/index.mjs` — one function for all of `/api/*` |
| Routing | Express | `vercel.json` rewrites `/api/(.*)` to the function and carries the real path in `__path`; the handler puts it back |
| Scheduled work | `node-cron` in `services/scheduler.ts` | Vercel Cron → `/api/ops/cron/*`, authorised by `CRON_SECRET` |
| Time limit | none | `maxDuration: 60` — every job is budgeted and resumable (§5.4) |

---

## 2. Configuration states

The system is designed to boot in every partial state rather than fail:

```
  no Supabase keys    → web shows ConfigNeeded · API data routes 503 · scheduler idle
  Supabase, no Google → app fully usable, Inbox stays empty, nothing to read
  Google, no Claude   → mail is fetched and filed UNCLASSIFIED; no tasks, no drafts
  everything set      → the full flow below
```

- `env.ts` treats every credential as optional and exposes `isSupabaseConfigured()`,
  `isGoogleConfigured()`, `isAnthropicConfigured()`.
- `requireAuth` returns `503 Backend not configured` rather than crashing when Supabase is absent.
- The Claude key resolves **studio settings first, environment second** (`lib/aiSettings.ts`),
  encrypted at rest with the same AES-256-GCM helper as the Google tokens, and only ever
  returned to the browser as its last four characters.

---

## 3. Sign-in, and the shape of every request

```
  Browser                     API                          Supabase
    │  supabase.auth sign-in    │                              │
    │──────────────────────────────────────────────────────────▶│
    │◀───────────── JWT ────────────────────────────────────────│
    │                           │                              │
    │  GET /api/… + Bearer JWT  │                              │
    │──────────────────────────▶│ 1. auth.getUser(token)       │
    │                           │─────────────────────────────▶│
    │                           │ 2. profiles → org_id, role, seat
    │                           │ 3. loadOverrides(orgId)  ← 15s cache
    │                           │ 4. db = supabaseForToken(jwt) ← RLS as the caller
    │                           │ 5. requirePermission(resource, action)
    │◀────── data ──────────────│                              │
```

Every authenticated handler receives `req.auth`: `{ userId, email, orgId, role, seat, db, permissions }`.

- **`db` is the caller's client**, not the service-role one. Row-level security decides what a
  query returns; the API never hands out an admin client on a user path.
- **`role` is coarse, `seat` is precise.** Two people can both be `assistant` and own entirely
  different outcomes, so work is routed by seat where a seat exists (`SEATS` in `packages/shared`).
- **Permissions are a matrix**, `role × resource × action`, with static defaults in
  `packages/shared` and sparse per-cell overrides stored in `organizations.settings.role_permissions`.
  The UI and the API read the same table, so a hidden button and a 403 always agree.
- The service-role client (`supabaseAdmin`) is reserved for work with no caller: the scheduler,
  ingestion, the permission read that must happen *before* we know what the caller may read, and
  the public usage report.

---

## 4. Connecting Google

```
  Settings → Connect Gmail
      │
      ├─▶ GET  /api/auth/google/url?service=gmail      consent URL, least-privilege scopes
      │        gmail.readonly · gmail.compose · drive.readonly
      │
      ├─▶ Google consent screen
      │
      └─▶ GET  /api/auth/google/callback               code → tokens
                │  encrypt(tokens) with TOKEN_ENCRYPTION_KEY
                │  merge granted scopes with what was already stored (incremental auth)
                └─ upsert integrations { user, status: connected, scopes, encrypted_tokens }
```

Disconnecting clears the stored tokens (`status: disconnected`); dropping a single service
removes just that service's scopes and keeps the rest. A revoked or rotated grant does not
become a 500 anywhere downstream — it surfaces as the reason `google_auth_failed`, which the
UI reads as *reconnect Google*.

---

## 5. The reading pass — `services/ingest.ts`

This is the main pipeline. One pass, one organisation.

### 5.1 What triggers it

| Trigger | Path |
|---|---|
| Scheduler tick (every minute) | `scheduler.ts` → any org whose interval is due → `runIngest(orgId)` |
| "Read Gmail & Drive" in the app | `POST /api/ops/ingest` |
| Vercel Cron | `GET /api/ops/cron/ingest` (`Authorization: Bearer $CRON_SECRET`) |

The tick fires every minute; **each studio is read only as often as it asked to be**
(Settings → Reading email, default every 10 minutes; "Only when I ask" turns polling off).
The setting is re-read each tick, so a change takes effect within the minute without a restart.

### 5.2 The pass

```
runIngest(orgId)
  ├─ guard  useAi && !isAiReady()      → reason: anthropic_not_configured
  ├─ guard  another pass in flight     → reason: busy        (5-min TTL lock, not a boolean)
  ├─ guard  no Google-connected user   → reason: no_source_user
  │          (the principal who connected Google — not "any principal")
  │
  ├── PROJECTS FROM DRIVE (first, so mail can be filed against them) ── §5.5
  │   CLIENTS/Projects/<numbered folder>          → an active project
  │   CLIENTS/Projects/Archived Client Project/*  → an archived project
  │   the status document in that folder          → client, stage, notes (when it changed)
  │
  ├── GMAIL ─────────────────────────────────────────────────────────────
  │   query: newer_than:3d -in:sent  minus the ignored-sender domains
  │   take 25 message ids, then for each one, while the budget allows:
  │
  │     already stored by gmail_id? ─────────────────▶ skip (free)
  │     machine mail (Slack, GitHub, Dropbox…)? ─────▶ skip (free, counted)
  │            │
  │            ▼
  │     classifyEmail()                    Claude #1 → class, confidence, hints, reply_to,
  │                                                    vendor contact, better project name
  │            │
  │     resolve project + vendor by name   (only when the hint really names a project)
  │            │
  │     INSERT emails { subject, body_text, links[], class, project_id, vendor_id, … }
  │            │
  │            ├─ promoteEmail()           create/link vendor + project, advance the stage
  │            ├─ createTaskFromEmail()    Claude #2 → a task, assigned by seat (§7)
  │            ├─ draftReply()             Claude #3 → a reply draft, for replyable classes
  │            └─ for each PDF attachment ≤ 12 MB:
  │                   extractPdf()         Claude #4 → quote / order confirmation
  │                   INSERT documents  →  promoteDocument() → vendor, project, PO, line items
  │
  └── DRIVE ─────────────────────────────────────────────────────────────
      vendor paperwork in active project folders, changed in the last 30 days, not yet read
      → up to 15 per pass → extract → documents (project = the folder's) → promoteDocument()
      (no project folder found: the 15 newest PDFs anywhere, as before)
```

Returns `{ ok, emails, documents, replies, tasks, skipped, done, remaining }`.

### 5.3 What one email costs

Up to four Claude calls: classify, raise a task, draft a reply, plus one per PDF. That is why
the two dials in Settings — **how often** and **whether Claude reads it** — are the ones that
move the bill. With reading turned off the mail is still fetched and filed; it simply arrives
unclassified and raises nothing.

### 5.4 The rules that keep a pass safe

| Rule | Why |
|---|---|
| **Budgeted** (`INGEST_BUDGET_MS`, default 20s) | Must finish well inside the platform's 60s, or the caller gets a 504 and *nothing* — not even the emails already written |
| **Stops between items, never mid-item** | A half-processed email may already have written a row and a draft |
| **Remembers the slowest item so far** | The deadline alone is not enough: starting a 20s email at second 44 still overruns |
| **Resumable** | Dedupe on `gmail_id` / `drive_file_id`, so the next pass resumes exactly where this one stopped |
| **Locked with a timestamp, not a boolean** | A serverless instance killed mid-run never reaches its `finally`; a boolean would answer "busy" forever |
| **Every per-item failure is caught** | One unreadable PDF must not cost the studio the other twenty-four messages |

Read state is deliberately *not* part of the Gmail query — the studio reads its own mail long
before the system gets to it. What prevents a double-read is the stored `gmail_id`.

`POST /api/ops/backfill-email-bodies` fills in the text and links of mail read before `0010`
added those columns. It costs Gmail calls only: no Claude, no re-classification, no new tasks.

Extraction runs at temperature 0: the same document gives the same fields on every read.

### 5.5 Projects from the studio's Drive folders — `services/driveProjects.ts`

The studio keeps every job in a folder of its own: *Design Department › CLIENTS/Projects ›
3. Bernthal*, with finished jobs under *Archived Client Project*. That list is the studio's own
record of its projects, so each pass reads it first:

- **Each folder is a project.** "1. Lemon's Project" becomes *Lemon*; archived folders become
  archived projects, which stay in the name list so mail about an old job ("Hardware Shorrs")
  files to it instead of inventing one. Matching is exact first, so *OVIS Cabana* and *OVIS Spa
  Cabana* stay two projects. A name found later in the paperwork ("Lemon Residence") is kept.
- **Only vendor paperwork in project folders is read** — quotes, estimates, proposals, bids,
  invoices, orders, reserves, budgets — changed in the last 30 days. Its project is the folder
  it is filed in, whatever the document calls itself. Archive and superseded folders inside a
  job are skipped. Drawings, renderings and moodboards are not read (two hundred in one month,
  each a Claude call, none of them a price); nothing outside the project folders is read at all.
- **The status document** in the folder (*Janelle Interiors Projects*) is read when it changes:
  each job's client (when missing or wrongly the studio), stage (forward only), and a notes block
  — location, who is on it, what is blocking it, urgency — replaced on each read, leaving notes
  people wrote untouched.

The folder name can be changed with the `drive_projects_folder` key in `organizations.settings`.

---

## 6. Promotion — `services/promote.ts`

Turning messages and PDFs into the records the studio actually works from.

```
  classified email / parsed PDF
            │
            ├─ upsertVendor()   fuzzy name match: normalised, diacritics stripped,
            │                   filler and generic words ignored
            ├─ upsertProject()  same matcher, plus a confidence floor (0.55) —
            │                   below it, nothing is invented
            ├─ purchase_orders  upserted on PO number (unique per org)
            ├─ line_items       from the parsed document
            └─ advanceStage()   a project moves FORWARD only, never back
```

`autoMergeDuplicates()` folds obvious duplicate projects together; every table that points at a
project follows the survivor. `findDuplicateProjects()` surfaces the ambiguous ones for a person
to judge, with a count of what is filed against each so the choice is informed.

---

### 6.1 Names come from the studio's own records

Every extraction — email, task, PDF — is given the studio's existing projects (with their clients),
vendors and team (`lib/studioNames.ts`, cached a minute and forgotten when a project or vendor is
created). The model uses a listed name exactly when the email means it, however the email says it:
"Lemon's project", "the Lemon job" and "Lemons 81326" all come back as **Lemon Residence**, and the
client is who the work is for — never a vendor or a team member. A new job is named the way the
studio would file it ("Henderson Residence"), and `cleanProjectName` removes possessives and the
word "project" before anything is saved.

A project is only ever renamed to a *better* name (`nameQuality`): "Lemon's" can become "Lemon
Residence", never the reverse — which is how a project used to lose its proper name to an email's
shorthand. When an email names only the client, a client with exactly one project finds it.

- **Better names arrive by themselves.** The model returns `better_project_name` when a listed
  project's name is poor and the email or document shows the proper one.
- **Sidemarks are not job names.** "Carissa 90826/Oak Kit" is Carissa's order of a date for the
  Oak Kitchen; a teammate's name, an order date or a PO number never makes a project name.
- **The client is never the studio, a builder or a design firm.** A client wrongly recorded as the
  studio is replaced when a real one appears, is never shown to the model, and never files a
  document — which is how an Ojai Valley Inn quote once landed in the Lemon job.
- **Software is never a vendor, client or project** — Slack, GitHub, Vercel, Dropbox, Houzz…
- **General studio mail can open a project or record a vendor** — a project when the model is
  sure it is a new client job with a proper name and a client; a vendor when the email carries the
  vendor's own address. The vendor's contact is that address, never the reply-to, which was often
  the client's.
- **Merges keep the best name**, and a survivor whose client was the studio takes a real one.

### 6.2 Attachments name the job

An email's attachments often say which job it is more plainly than the body — "attached is the
updated proposal" names nothing, while the proposal's cover says *Lemon Residence, prepared for The
Lemons*. So the reading pass works in this order:

```
  getEmail ── every attachment's name and type (email.files)
     │
     ├─ read its PDFs FIRST (up to 4; the ones already stored are reused, not re-read)
     │     extractPdf looks where documents name the job: cover page, drawing title block,
     │     "Project:" / "Client:" / "Prepared for", and a vendor quote's SIDEMARK
     │
     ├─ classifyEmail(body + ATTACHMENTS: what each PDF said, and every file name)
     ├─ file it: the email's own reading, else the first attachment that names a job on file
     ├─ store the email → promote → store its documents under the project it ended up on
     └─ raise the task (titled with that project's name) → draft the reply
```

The same PDFs were always read — they were read *after* the email had been filed, when they could no
longer change it — so the new order costs no extra Claude calls. An email whose attachments do not fit
in what is left of a pass waits for the next pass rather than being filed without them (unless it is
the first email of the pass, so a slow attachment cannot starve it).

After every complete pass, `refileFromAttachments` files older email that still has no project, using
what its stored attachments already said — the email, its documents and its task together. It matches
only projects on file and makes no Claude calls. Also available as `POST /api/ops/refile-emails`.

### 6.3 The studio's own people

Accounts (`profiles`) decide who can sign in and who a task can be given to. The studio's team list
(`lib/studioTeam.ts`) covers what accounts cannot:

| Person | Address | Seat |
|---|---|---|
| Janelle Kandziora | janelle@janelleinteriors.com | Owner |
| Carissa Kolbeck | carissa@janelleinteriors.com | Operations + Finance |
| Joanna Ramos | ramos.joannaeve@gmail.com | Operations Support / PM assistant |
| Victoria Manayan | manayan.victoriam@gmail.com | Technical production |
| Adeleigh McGee (the roles document spells her "Adelaide") | adeleigh@janelleinteriors.com | Hotel FF&E / Procurement |
| Brianna Johnson | brianna@janelleinteriors.com | Lead / Technical Designer |
| Amanda Neubecker | amanda.neubecker@gmail.com | Lead / Technical Designer |
| Taryn Choquette | taryn@janelleinteriors.com | — (no seat in the roles document) |

- **A teammate without an account is still a teammate.** Every extraction's name list is accounts
  plus this list, with each person's seat and other spellings, so mail from a personal Gmail address
  is a colleague's — never a client's, and never a vendor contact.
- **The studio is not a person.** Any `@janelleinteriors.com` address is the studio writing, and the
  shared inbox `systems@janelleinteriors.com` is never a client, a vendor or a task's owner — even
  though an account signs in with it.
- **Guards after the model, too.** `promote.ts` refuses a teammate's name or the studio's as a vendor,
  a client or a project, and never records a studio address as a vendor contact.
- **One matcher for people** (`matchPerson`): real people first, by every name they go by, and a
  shared inbox only when no person matches — so "Janelle" is Janelle Kandziora, not the
  "Janelle (Admin)" account.

**Managing the team** (Team & roles): add a person (no email unless *Email them a sign-in link* is
ticked), edit their name and sign-in email (confirmed on the spot, so nothing is emailed), change
role and seat, and remove them. Removing deletes the sign-in account; their open tasks stay on the
board unassigned. It is refused for yourself, for the last principal, and for the account the
studio's Gmail and Drive are connected through. Who may do each is the permission matrix's
`team.create / update / delete` (`GET /api/team/can`).

## 7. Raising a task — `services/tasks.ts`

```
createTaskFromEmail(orgId, emailId, class, parsedEmail)
  ├─ class ignored (houzz_notification)?      → no task
  ├─ this email already raised one?           → no task  (unique index, cheap pre-check)
  ├─ extractTask()                            Claude → needs_task? title, kind, seat,
  │                                                    next_step, due_date, assignee_hint
  ├─ same title already open on this project? → no task  (one live task per piece of work,
  │                                                       scoped per project, not per studio)
  │
  ├─ WHO OWNS IT — five steps, most specific first:
  │     1. a person named in the body         the sender already decided
  │     2. whoever the mail was addressed to  the chain says who was asked
  │     3. the seat that owns this outcome    per the studio's roles document
  │     4. the role that owns this kind       TASK_KIND_ROLE
  │     5. whoever runs the board             so nothing is created ownerless
  │
  └─ INSERT tasks { title, kind, seat, assigned_role, next_step, due_date, … }
        due_date = the email's own date, else the studio's SLA for that kind.
        A task with no date cannot be chased for being late, so "none" helps nobody.
```

**Seats resolve to people** in this order: the account given that seat on Team & roles, then the
people the roles document names for it — by their address, their full name, then their first name if
nobody else shares it. The names used to be first names only, and "Adelaide" matched nobody, so hotel
work never reached Adeleigh. Mail addressed to the shared inbox is never "the person who was asked".

The task carries the **vendor** (the email's, or one the task names that is on file) and a
**Contact:** line with the outside person to reach — never a studio address or a no-reply sender.
Shared inboxes never own work, by name, by address or by role.

The email's filing is read **before** the task is written, so the title names the job by its real
name ("…for Lemon Residence", never "…for Lemon's Project"). A named person is matched with the same
careful matcher Jenny uses (whole name, every word, spelling slips — never a guess between two), and
the same title already live on the same job, or on a job and on none, is a duplicate.

Tasks answer the studio's six questions — what, where, status, next step, who, when — which is
why `seat` and `next_step` are columns (`0006`) rather than prose buried in `detail`. Subtasks
are tasks owning tasks (`0009`), so a step gets its own owner, date and status.

---

## 8. Nightly follow-ups (02:00) — `services/followups.ts`

One scan builds a list of triggers; each becomes a deduped `follow_ups` row and, where a
recipient is known, a **draft**.

```
  OUTWARD (a vendor or a client)          INWARD (the studio's own people)
  ──────────────────────────────          ─────────────────────────────────
  vendor_silence      PO placed, no       task_overdue       past its date, or blocked,
                      confirmation                           or simply old with no date
  date_slipping       past ETA,           task_escalation    already nudged, still open
                      not received                           → the principal is told
  client_approval_    stuck in            task_unowned       ┐ hygiene: the SOP wants
  overdue             "approval"          task_no_next_step  │ ONE owner, a due date
  quote_overdue       quote open past     task_no_due_date   ┘ and a next step
                      the studio's SLA
  client_waiting      client waiting      spec_gap           missing info blocking an order
                      past the window
```

Rules that keep it from becoming noise:

- **Deduped** against any open follow-up of the same kind for the same task / project / vendor.
- **On a cadence** — `reminded_at` is stamped, and nothing is nudged again until
  `reminder_repeat_days` has passed.
- **Hygiene does not count as a reminder.** Being told a task has no next step is not being
  chased for lateness, and the reminder count is what decides escalation.
- **Internal nudges never resolve against a vendor thread**, or a reminder would be addressed
  to the vendor.
- **Escalation is deliberately narrow.** Escalating everything is the same as escalating nothing.

Recipients are resolved from the real correspondence where possible (the right person, the right
thread, the right CCs), falling back to the vendor's stored contact. Drafting the body is a
Claude call with a plain-text fallback, so the engine still works when Claude does not answer.

---

## 9. Morning digest (07:05 daily) — `services/digest.ts`

The push side: what is overdue, who owns it, and what genuinely needs the principal — assembled
so nobody has to log in to find out.

```
  live tasks + open follow-ups + team
        │
        ├─ overdue         past due, or blocked
        ├─ unassigned      nobody owns it — the quietest failure mode
        ├─ quote_breaches  past the studio's quote SLA; the client is waiting
        ├─ client_waiting  past the response window
        ├─ by_owner        workload per person
        └─ escalations     overdue past the escalation window, or blocked  ← narrow on purpose
                  │
                  ▼
        writeNarrative()   Claude → a short summary a busy principal reads on a phone
                  │
        upsert digests (one row per org per day) + activity_log
```

**Nothing is emailed.** The digest is stored and surfaced in-app; sending is a separate,
human-initiated step.

---

## 10. Weekly report (Monday 07:00) — `services/report.ts`

Aggregates the week — projects moved, POs placed and received, follow-ups raised, documents
parsed — and has Claude write the narrative over those figures. One row per `week_of`, so a
re-run corrects the week rather than duplicating it.

---

## 11. Jenny, the assistant — `services/assistant.ts`

A bounded tool loop over the studio's own records. She answers from data, not from memory.

```
POST /api/assistant  { message, history }
   │
   ├─ system prompt = studio rules + a live snapshot (projects, tasks, team, seats)
   │
   ├─ up to 6 turns, while the clock allows:
   │      Claude ──▶ tool calls ──▶ runTool() ──▶ Supabase (as the caller, RLS-scoped)
   │         ▲                                       │
   │         └──────── all results in ONE message ◀──┘
   │
   └─ the turn ends when Claude calls `answer` — which IS the answer (§11.1)
```

Three groups of tools. **Writes come back as proposals, never actions** — a person confirms.

| Group | Tools | Runs as |
|---|---|---|
| Studio records | `list_projects`, `list_tasks`, `search_email`, `read_email`, `search_documents`, `list_purchase_orders`, `get_studio_rules`, `get_ai_spend` … | the caller (RLS) |
| Live Google | `find_attachments`, `gmail_search`, `gmail_read`, `drive_search`, `drive_read` | the studio's Google account |
| Proposals | `propose_task`, `propose_draft` | nothing, until confirmed |

**Live Google is principal and coordinator only.** Those tools act as the principal's own Google
account, which holds far more than studio work — and reads in this system are open to every role
by design (`isLockedPermission`), so the permission matrix cannot restrict them. They are held to
the roles that already read the full audit trail. Every other role still gets attachments from
mail and documents they can already see, through `read_email` and `search_documents`.

**Nothing is sent, and Drive is never changed.** `propose_draft` puts a draft in Drafts after the
person reads it in full and confirms; they send it from Gmail. Drive holds a read-only scope.

### Handing over a file

```
  find_attachments / gmail_read / read_email / search_documents / drive_search
        │
        ├─ gmailFileRow() / driveFileRow()
        │     sealFileGrant({ org, message+attachment | file, name, type })
        │     AES-256-GCM: unreadable, untamperable, org-bound, 12h expiry
        │
        └─ row registered as a ref ("F1") ──▶ answer { items: [{ ref: "F1" }] }
                                                       │
   browser: Download / Open ──▶ GET /api/assistant/file?token=…
                                   ├─ openFileGrant: valid? this org? not expired?
                                   ├─ bytes from Gmail, or Drive (Docs/Sheets exported)
                                   ├─ > 4.3 MB on Vercel → 413 + "Open in Gmail/Drive"
                                   └─ always Content-Disposition: attachment, nosniff
```

The browser never sees a Gmail or Drive id, so it cannot request a file it was not shown. Only
PDFs, raster images and plain text are previewed (from a blob, re-typed on the client); HTML and
SVG attachments would run as the app from a same-origin blob, so they download instead.

If live Gmail is unreachable, `find_attachments` searches the stored documents itself rather than
leaving that to the model — in testing, whether the model thought to do so varied run to run.

### 11.1 The shape of an answer

An answer is not a paragraph. Claude ends its turn by calling `answer`, and what it passes is
what the app renders:

```
  lead     the answer in a sentence or two — stands up on its own
  items[]  the records it is ABOUT — usually just { ref: "P3" }
  more     how many were left out, so nothing truncates silently
  caveat   one clause, only when something genuinely failed to load
  speech   the same answer as prose, for reading aloud
  sources  derived server-side from the tools actually used
```

**Rows are references, not transcriptions.** Every row a tool returns is registered, fully
formatted, under a short ref (`P3` project, `T1` task, `O2` order, `V1` vendor, `E4` email, `F1`
file). The model answers with refs and the server swaps each for its row — so a list of twenty
projects costs a few tokens instead of seconds of output, every figure is the database's own, and
an invented ref is dropped rather than rendered. The model may add `meta` or `tone`; it cannot
change the facts.

**Rows carry labelled `fields`**, formatted once per record type (`projectRow`, `taskRow`,
`purchaseOrderRow`, `vendorRow`, `gmailFileRow`, `driveFileRow`). The UI picks the layout from
the rows themselves: like records sharing the same labels become a **table** (cards on a phone),
files become **file rows** with Download and Open, anything else stays a list.

Three things follow from it:

- **Rows link into the app.** `assistantItemHref` (in `packages/shared`) turns `kind` + `id`
  into `/projects/:id`, `/tasks?task=:id`, or the screen that kind lives on. An id that is not a
  uuid falls back to the screen rather than becoming a dead link.
- **Screen and voice never compromise for each other.** `speech` names the worst one or two and
  the count; the screen gets all eight rows.
- **The shape is guaranteed at the edges.** Every field is clamped and sanitised on the way out
  (`toAnswer`), a URL that is not plainly http(s) is dropped, an answer given as plain text is
  laid out by `answerFromText`, and the out-of-time path calls `answer` with `tool_choice`
  forced — so the worst moment is not also the one guessing at a format.

Two things protect the answer:

- **A time budget** (`ASSISTANT_BUDGET_MS`, default 40s) that holds back the slowest turn so far.
  When it runs out she spends what is left on an answer with the tools removed, rather than
  being cut off mid-lookup and reaching the browser as "could not reach the server".
- **A failed lookup says so.** A tool error is returned as *tell the user you could not check
  this — do NOT say there are none*, because a confident "nothing found" over a failed query is
  the one answer that does real damage.

### 11.2 How she is used — a personal assistant, not a page

```
  AssistantProvider (context/AssistantContext.tsx) — above every page
     │  conversations · briefing · voice loop · panel state
     │  remembered per person, per browser (localStorage: 40 conversations, 60 messages each)
     │
     ├─ header launcher "Ask Jenny"  ⌘K / Ctrl K from anywhere  ·  badge = unopened briefing
     ├─ side panel (AssistantPanel)  docks beside the page on xl screens; full screen on a phone
     │                                history button → the list of past conversations
     └─ /assistant                    conversations on the left, the chat on the right,
                                      "What Jenny can do" as a sheet; the list is a sheet on a phone
```

- **Past conversations.** "New conversation" keeps the last one in the list (grouped Today /
  Yesterday / Previous 7 days …, searchable). Each can be renamed, pinned to the top, downloaded as a
  text file, or deleted — which also deletes the files attached in it. An answer always lands in the
  conversation it was asked in. The single conversation older versions kept becomes the first one.
- **What she can do.** A new conversation opens with a guide: a complete question is asked at once,
  one that needs a name ("Create a task for…") is put in the box to finish, and "Attach a file" and
  "Start talking" start those. Email & Drive wording follows the person's role.

- **She speaks first.** Once a day, as the app loads, `GET /api/assistant/briefing` builds
  what needs *this* person — their overdue and due-today tasks, plus what their seat exists to
  catch (escalations and clients waiting for the principal, unowned tasks for whoever runs the
  board, late orders for procurement, spec gaps for design). No model call: it is instant, free,
  and counts are never paraphrased (`services/briefing.ts`).
- **She knows where you are.** Every question carries the page path; on a project page
  `describePage()` reads that project with the caller's own client, so "is anything late on this
  one?" needs no name.
- **She knows who you are.** The profile's full name, not the session email, so "my tasks" match.
- **You watch her work.** `POST /api/assistant/ask?stream=1` answers in newline-delimited JSON —
  `status` lines ("Searching Gmail · Searching Google Drive") then the `result`. A host that
  buffers still delivers every line at the end; only the live progress is lost.
- **She offers the next step.** Every answer carries up to three `suggestions`, shown as chips.
- **Hands-free.** *Talk* speaks each answer, then listens for the reply; two silences end it, and
  closing the panel always does. A request that never reached the server (a dropped connection, the
  API restarting) is asked again, up to twice, before an error is shown. She uses a woman's voice — the platform's natural "Jenny"/"Aria"
  where it exists, Chrome's own voice, Samantha on Apple, Zira as the fallback (`lib/speech.ts`).
  Everything spoken passes through `speakable()` first, so no symbol is ever read aloud — dashes,
  slashes, brackets, quotation marks, bullets and links become pauses or go.

### 11.3 Saying yes

```
  "Create a task for Danish…"
     └─ propose_task ── matches "Danish" → Denish Patel NOW (services/proposals.ts: matchName)
                        no match / two matches → she asks; nothing is prepared on a guess
                        → proposal shown: Confirm · Dismiss · "or just say yes"

  "yes confirmed and add in a task list"            [Confirm] button
     └─ browser sends the unanswered proposals          │
        with the question (pending)                     │
     └─ respond_to_proposal { #1, confirm } ────────────┴─▶ commitProposal()
                                                            permission · owner · project
                                                            same title in 10 min → that one
     └─ result.settled → the earlier proposal reads "Added to Tasks"
```

- **One way through.** The button and a spoken or typed "yes" both save through
  `commitProposal`, with the same checks and the same audit record (`via: button | conversation`).
- **The model is told the truth.** History marks every proposal *saved*, *turned down* or *NOT saved
  yet*, and the prompt lists what is waiting — so it can never read "I've prepared it" as done.
- **Changes are not confirmations.** "Yes, but make it Friday" cancels the old proposal and prepares
  a new one; "no, leave it" cancels.
- **Every turn is a tool call** (`tool_choice: any`), so an answer is always structured — no
  plain-text reply ending in "Would you like me to…".
- **Tasks from email.** `search_email` says which email already raised a task (`without_task` lists
  the ones that have not); `propose_task` takes an `email_id`, linking the task and bringing the
  email's project and vendor. An email that already has a task gets `propose_task_update` instead —
  owner, due date, status or next step, under the same rules as the Tasks board.

### 11.4 Reading a document, and showing its pages

```
  "From this PDF, give me the living room furniture & decor"
     └─ read_document { file: F1, question }
          fetchGrantedFile (services/files.ts) ─▶ the PDF or image
          readDocument (services/documentReader.ts) ─▶ Claude reads text AND pictures
             → answer · findings (with page) · pages that SHOW it
          sealFileGrant({ …grant, pages: [3, 4] }) ─▶ preview ref
     └─ browser: GET /api/assistant/file (grant with pages)
          server cuts just those pages with pdf-lib ─▶ small PDF
          pdf.js draws each page to an image (loaded only when a preview appears)
```

"This PDF" resolves because the browser sends the grants of files handed over earlier; the server
opens each and registers it as a ref before the question is read. Rendering happens in the browser
because server-side PDF rendering needs native graphics libraries a serverless host lacks — and
cutting to the relevant pages first keeps a large deck under the host's response size limit.

### 11.4a Attaching a file

```
  📎 / drop / paste a PDF or image
     └─ POST /api/assistant/upload?name=…   raw bytes, ≤ 4.3 MB on Vercel (20 MB elsewhere)
          type decided by the file's first bytes — never its name or Content-Type
          stored in the private bucket "assistant-uploads" (made on first use)
             <org>/<person>/<uuid>/<name>
          ← a sealed upload grant, valid 30 days
     └─ ask { message, attachments: [grant] }
          registered as F refs and flagged "ATTACHED to this question"
          → read_document reads it (no mailbox or Drive search)
     └─ later questions send it with the earlier files, so "and the bench?" still reaches it
     └─ POST /api/assistant/uploads/forget   removing a chip, or deleting the conversation
```

The upload starts as soon as the file is chosen, so sending does not wait on it. A file sent on its
own asks "Take a look at …". Only the uploader can delete their uploads.

### 11.5 Hearing it right

- Up to five hearings per utterance; `bestHearing()` prefers the one containing names the studio
  actually uses (`GET /api/assistant/vocabulary` — team, projects, clients, vendors), because a
  recogniser is sure of "Danish" and unsure of "Denish".
- The question travels with every hearing (`spoken.alternatives`), and the model is told it was
  spoken, so names are matched rather than taken at their word.
- Never listening to herself: the microphone waits until she has finished (plus a beat), pressing
  the mic interrupts her first, and a hearing that repeats her last sentence is discarded
  (`soundsLikeEcho`).
- Push-to-talk shows the words as they are heard and leaves them in the box to check, adding to what
  was typed; hands-free Talk sends on its own.
- **Waiting for the end of the sentence.** The browser used to decide when someone had finished, and
  it decided at the first breath — "hey can you give me the" was sent mid-sentence. Listening is now
  continuous and the sentence ends in `listen()`: after a 2-second pause (2.6 s for push-to-talk),
  1.8 s longer when the last word leaves it hanging ("the", "to", "for", "can"…), 1 s longer while
  the browser is still revising the last words. The microphone button, or *Send now* on the voice
  bar, ends it at once.

---

## 12. Prompt Studio

```
  prompts (library, seeded + studio-authored)
     │  {{variables}} filled from the form; required ones enforced
     ▼
  POST /api/prompts/:id/run ──▶ Claude ──▶ output
     │
     ├─ INSERT prompt_runs   (input + output, per project, per user)
     └─ optionally saved as a draft
```

---

## 13. Drafts → sent mail (the human step)

Every outbound message the system composes — a reply, a nudge, prompt output — lands in the
`drafts` table and is reviewed in the app.

```
  Drafts screen
    ├─ edit    To / Cc / subject / body (rich text), logged to activity_log
    ├─ copy    plain text
    ├─ open in Gmail   compose deep link, every field prefilled
    └─ delete  after sending it manually, or dismissing it
```

**Nothing is auto-sent.** Drafts are kept in the system rather than pushed into Gmail, and the
final press of Send happens in the person's own mailbox. (`gmail.createDraft` exists and is
wired for the Gmail-side variant, but no flow calls it today.)

---

## 14. Spend accounting

Every Claude call in the system goes through one chokepoint, `services/anthropic.ts`, so a new
caller cannot quietly spend money without showing up.

```
  createMessage(ctx, params)
      │  ctx.feature ∈ email.extract · task.extract · document.extract · followup.draft ·
      │                reply.draft · digest.summary · report.narrative · prompt.run ·
      │                assistant.answer
      ├─ call Claude (25s timeout, 1 retry — the SDK's own 10-minute default outlives
      │               the function it runs in)
      └─ record() → activity_log { action: 'ai.usage', meta: tokens, cost_usd, latency, ok }
                    success or failure, never throws, never blocks the caller
```

`services/usage.ts` reads those rows back into the report: by feature, by model, by person, and
split **agent vs person** — what the system spent working, against what somebody spent pressing
a button. The report is also shareable: `/u/:token` renders it with no sidebar, no sign-in and
no session, because the studio needs to show what the agent costs to someone who has no account.
The token is the credential, it is rate-limited, and it can be rotated from Settings.

---

## 15. Houzz import

Houzz Pro has no API for this, so a CSV export is the only route in. `POST /api/ops/import-houzz`
parses it, maps Houzz's own stage words onto the studio's pipeline, and upserts projects on
`houzz_ref`. Houzz stays the source of truth and **nothing is ever written back to it**.

---

## 16. Scheduled work

| Job | When | Local | Vercel |
|---|---|---|---|
| Read Gmail + Drive | per-studio interval (default 10 min) | `node-cron`, every-minute tick | `/api/ops/cron/ingest` |
| Follow-ups | 02:00 daily | `node-cron` | `/api/ops/cron/follow-ups` |
| Morning digest | 07:05 daily | `node-cron` | `/api/ops/cron/digest` |
| Weekly report | Monday 07:00 | `node-cron` | `/api/ops/cron/report` |

Cron routes are declared **before** `requireAuth` and authenticate with `CRON_SECRET`; they
return `503` when the secret is unset rather than running unprotected. Each one loops over every
organisation, sharing a single request budget (`CRON_BUDGET_MS`, default 45s) — an org reached
with no time left is skipped and reported, not started and cut off. Every one of these jobs is
also reachable on demand from the UI.

---

## 17. Who writes what

| Table | Written by | Read by |
|---|---|---|
| `emails` | ingest | Inbox, assistant, tasks, digest |
| `documents`, `line_items` | ingest → extract | Documents, POs, project detail |
| `projects`, `vendors`, `purchase_orders` | promote, Houzz import, people | everything |
| `tasks` | ingest (from email), people, assistant proposals | Tasks board, digest, follow-ups, dashboard |
| `follow_ups` | the nightly engine | Follow-ups screen, digest, dashboard |
| `drafts` | ingest (replies), follow-ups, Prompt Studio, people | Drafts screen |
| `digests` | the daily digest job | Dashboard, digest screen |
| `reports` | the Monday job | Reports |
| `prompts`, `prompt_runs` | seed + people | Prompt Studio |
| `integrations` | the Google OAuth flow | ingest (decrypted per call) |
| `activity_log` | everything, plus every Claude call | Audit Log, usage report |
| `organizations.settings` | Settings, Permissions | permissions, SLA, ingest dials, AI key + model |

Schema lives in ordered migrations, `supabase/migrations/0001…0010`. Enum extensions
(`alter type … add value`) cannot run inside a transaction — `scripts/db-apply.mjs` knows which
files those are.

---

## 18. The dials that change the flow

| Dial | Where | Effect |
|---|---|---|
| Reading interval | Settings → Reading email | How often mail is fetched; `0` = only on demand |
| Claude reads mail | Settings → Reading email | Off: mail is filed unclassified, no tasks, no drafts, no spend |
| Model + API key | Settings → AI | Applies to every feature at once; key encrypted at rest |
| SLA days / hours | Settings | Quote response, client waiting, vendor silence, reminder cadence, escalation |
| Permission matrix | Permissions | Any non-locked `role × resource × action` cell; effective within 15s |
| Ignored domains | `INGEST_IGNORE_DOMAINS` | Extra senders dropped before they cost anything |
| Budgets | `*_BUDGET_MS` | How long a pass, a job or an answer may work before reporting what it has |

---

## 19. Failure rules, in one place

1. **A missing credential is a state, not a crash.** Every precondition returns a named reason
   (`no_source_user`, `google_auth_failed`, `anthropic_not_configured`, `busy`).
2. **A timeout is a partial success.** Jobs stop short of the platform's limit and report what
   is left; the next call resumes.
3. **One bad item never costs the batch.** Per-email, per-attachment and per-trigger failures
   are caught and logged.
4. **A write that failed is never counted as a success.** A report that is wrong is worse than
   one that fails, because nobody goes looking.
5. **A failed read is never reported as an empty result** — in the assistant, and everywhere a
   count is shown.
6. **Book-keeping never blocks the work.** Usage recording swallows its own errors.

---

## 20. Where each flow lives

```
apps/api/src/
  index.ts            local server + scheduler          app.ts   routes, CORS, error handling
  env.ts              every credential, all optional
  middleware/auth.ts  requireAuth · requirePermission · requireRole
  lib/
    supabase.ts       admin client + per-request RLS client
    tokens.ts         encrypted Google tokens, per user
    crypto.ts         AES-256-GCM
    permissions.ts    the override matrix (15s cache)
    aiSettings.ts     studio Claude key + model (30s cache)
    ingestSettings.ts the two reading dials (30s cache)
    columns.ts        feature-detects columns from unapplied migrations
    fileTokens.ts     §11 encrypted, org-bound download grants for files Jenny hands over
    uploads.ts        §11.4a files people attach: type sniffing, the private bucket
    studioNames.ts    §6.1 the names every extraction is read against
    studioTeam.ts     §6.3 the team list, the studio's domain and its shared inbox
  services/
    scheduler.ts      the four jobs, when self-hosted
    ingest.ts         §5 the reading pass         gmail.ts / drive.ts  Google clients
    driveProjects.ts  §5.5 projects, paperwork and status from the Drive project folders
    extract.ts        §5 classify · task · PDF    promote.ts           §6 records + merges
    tasks.ts          §7 raising and assigning    reply.ts             reply drafts
    followups.ts      §8 the nightly engine       digest.ts            §9 the morning digest
    report.ts         §10 the Monday report       assistant.ts         §11 Jenny
    anthropic.ts      §14 the one Claude chokepoint + usage recording
    usage.ts          §14 the spend report        houzz.ts             §15 CSV import
  routes/             one thin file per resource; ops.ts holds the jobs and the cron lane

apps/web/src/
  App.tsx             routing; /u/:token bypasses the shell and the session
  context/            AuthContext (session + profile) · ThemeContext
  lib/queries.ts      every server call, TanStack Query
  context/AssistantContext.tsx     §11.2 conversations, briefing, voice loop, attachments
  components/AssistantAnswer.tsx   §11 answers as tables, rows and files
  components/AssistantChat.tsx     §11 the conversation and the composer (attach, voice)
  components/AssistantHistory.tsx  §11.2 past conversations      AssistantGuide.tsx  what she can do
  lib/speech.ts                    §11.5 listening and speaking
  pages/              Dashboard · Projects · Vendors · Inbox · Documents · Prompts ·
                      Assistant · Tasks · FollowUps · Drafts · Reports · Activity ·
                      Team · Permissions · Settings · UsageReport

packages/shared/src/index.ts
  roles · seats · the permission matrix · task kinds and SLAs · dashboard cards per role ·
  model pricing · AI features — imported by both sides so there is one definition of each

supabase/migrations/  0001 baseline · 0002 tasks · 0003 digests + SLA · 0004 role permissions ·
                      0005 task reminders · 0006 seats + next step · 0007 dynamic permissions ·
                      0008 profile seats · 0009 subtasks · 0010 email body + links
```

---

## 21. The one-paragraph version

Mail and Drive are read on the studio's own schedule. Claude classifies each message, links it
to a project and a vendor, raises a task with one owner, a date and a next step, and drafts a
reply where one is warranted; PDFs become quotes, orders and POs. Every night the engine looks
for what has gone quiet, late or malformed and prepares the nudge. Every morning a digest says
what is overdue and what needs the principal; every Monday a report says how the week went.
Anyone can ask Jenny about any of it and get an answer from the records rather than a guess.
**Every outbound message stops in a draft, and a person presses Send.**
