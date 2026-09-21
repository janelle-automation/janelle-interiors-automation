# Grok media for Jenny — implementation plan

Giving Jenny the ability to **make a picture and make a short video** from a written or spoken
brief, using xAI's Grok Imagine models, alongside the Gemini board renderer that already exists.

> **Status: built, 21 September 2026.** Everything in §6's checklist is done except the Settings
> panel, and the whole thing is inert until two steps are taken — see *What is left* below. The plan
> below is kept as written, with the three places the implementation deviated from it marked.

### What is left

| | |
|---|---|
| **Set a key** | `XAI_API_KEY` in `.env` (or per studio via `PUT /api/settings/media/key`). Without one, both tools refuse in words. |
| **Apply migration 0014** | `npm run db:apply` cannot connect — `SUPABASE_DB_URL` holds the project URL, not a Postgres URI. Run `supabase/migrations/0014_media_jobs.sql` in the Supabase SQL editor. `make_video` refuses until the table exists, and refuses *before* spending anything. |
| **Run the probe** | `npm run grok-probe` — confirms the image API's field names against the real account (§3.1 is still the one unverified part). |
| **Not built** | The Settings screen panel for the Grok key. The endpoints behind it exist and work; only the UI is missing. |

### Where the implementation deviated from this plan

1. **Grok models are a separate registry, not added to `IMAGE_MODELS`.** The plan said to add a Grok
   entry to the existing list. That would have been a trap: `services/images.ts` posts to Gemini's
   endpoint and nothing else, so a Grok id picked in the board dropdown would be sent to Google and
   404. There are now two lists — `IMAGE_MODELS` (boards, Gemini) and `GROK_IMAGE_MODELS` /
   `VIDEO_MODELS` — with no way to pick one and reach the other.
2. **Spending is guarded by a daily cap, not by the Confirm button.** §7 recommended routing
   `make_video` through the existing proposal mechanism. That turned out to reach further into the
   front-end confirm flow than the rest of this change, so the guard is now three things that hold
   server-side regardless of what the model does: `MEDIA_MAX_SECONDS` (default 8), a
   `MEDIA_DAILY_USD_CAP` counted from what has actually been billed today (default $5), and a
   two-call quote — the first `make_video` spends nothing and returns the cost for Jenny to read
   back. The quote is a soft guard; the two caps are not. Routing it through Confirm is still the
   better end state.
3. **`video.render` was added as a feature; images through Grok stayed on `image.render`.** As
   planned — noted here because it means the usage report compares Gemini and Grok stills directly.

---

The plan as originally written follows: what exists, what the provider actually offers, the
constraints that decide the shape, and a file-by-file order of work.

| | |
|---|---|
| Written | 2026-09-21 |
| Provider facts verified against | `docs.x.ai` on 2026-09-21 |
| Branch this targets | `feat/tasks-digest-assistant` (or a fresh `feat/grok-media`) |
| Companion docs | [`PROJECT-FLOW.md`](PROJECT-FLOW.md) · [`WORKFLOW-AND-FUNCTIONALITY.md`](WORKFLOW-AND-FUNCTIONALITY.md) |

---

## 1. Scope

**In scope**

1. A Grok provider module that generates a **still image** from a prompt plus reference images.
2. A Grok provider module that generates a **short video** (text-to-video and image-to-video),
   asynchronously, because that is the only way the provider offers it.
3. Two new tools on Jenny's tool surface — `make_image`, `make_video` — so a spoken or typed
   sentence reaches them.
4. Delivery of the result into the answer: the picture previewed inline, the video playable inline.
5. The per-studio key and model settings, and the spend landing on the usage report like everything
   else.

**Out of scope (deliberately)**

- Replacing the Gemini board renderer. `render_board` stays as it is: the house presentation
  template is a typography job, `images.ts` already holds the reference-matching logic and the SVG
  fallback, and swapping its provider is a separate decision with its own risk. Grok is **additive** —
  renderings, concept imagery, walk-throughs — not a rewrite of the board path.
- Long-form video, editing, stitching, or a video timeline UI.
- Auto-publishing anything to a client. Same rule as the rest of the system: a person approves.

---

## 2. What already exists (the seam to build into)

The app already has every part of this pattern once. The work is mostly a second instance of it,
plus one genuinely new thing (async jobs).

| Concern | Where it lives today | Reuse |
|---|---|---|
| Image provider, provider-shaped interface | `apps/api/src/services/images.ts` — `renderImage(prompt, references, ctx)` | Copy the shape, not the code |
| Provider key + model, per studio, encrypted | `apps/api/src/lib/aiSettings.ts` — `resolveImageAi`, `saveImageApiKey`, `IMAGE_KEY_FIELD` | Same pattern, new fields |
| Env fallback for a provider | `apps/api/src/env.ts:57` — `env.images` | Add `env.xai` |
| Model registry + per-unit pricing | `packages/shared/src/index.ts:755` — `IMAGE_MODELS`, `imageCostUsd` | Add Grok entries + `VIDEO_MODELS` |
| Spend recording for a non-token call | `images.ts` → `record()` writing `activity_log` with `action = 'ai.usage'` | Same row shape |
| Storing produced bytes | `apps/api/src/lib/uploads.ts` — `assistant-uploads` bucket, `storeUpload` | Add `video/mp4` |
| Handing a file to the browser safely | `apps/api/src/lib/fileTokens.ts` — sealed `FileGrant`; `GET /api/assistant/file` | Reuse for images |
| A produced picture appearing in an answer | `assistant.ts:2333` `case 'render_board'` → `refs.add('F', { kind: 'file', preview: 'image', … })` | Exact same move |
| Inline preview in the browser | `apps/web/src/components/AssistantAnswer.tsx` — `PagePreview`, `PREVIEWABLE` | Add a video branch |
| Voice in and voice out | `apps/web/src/lib/speech.ts` — `listen`, `bestHearing`, `speak` | Already done; see §7 |

**Two things worth knowing before starting**

- `imageSettingsView`, `saveImageApiKey`, `saveImageModel`, `clearImageApiKey` in `aiSettings.ts`
  are **written but wired to nothing** — no route in `routes/settings.ts`, no UI in
  `apps/web/src/pages/Settings.tsx`. Image config is environment-only in practice today
  (`GEMINI_API_KEY`). The Grok key should be wired properly, and the same endpoint can pick up the
  image key that is already sitting there unused.
- `IMAGE_TIMEOUT_MS` defaults to **180s** in `images.ts`, which cannot complete on Vercel at all —
  `vercel.json` caps the function at 60s. On the current host a slow board is killed by the platform,
  not by that timeout. Do not copy the 180s; see §4.

---

## 3. What the provider actually offers

Verified against `docs.x.ai` on 2026-09-21. Base URL `https://api.x.ai/v1`,
auth `Authorization: Bearer $XAI_API_KEY`.

### 3.1 Images — synchronous

```
POST /v1/images/generations
{ "model": "grok-imagine-image-2.0", "prompt": "…" }
```

- Up to 10 images per request; aspect ratio, resolution and response format are configurable.
- OpenAI-shaped response: the documented example reads `response.data[0].url`.
- **Unverified:** whether `response_format: "b64_json"`, `n` and `aspect_ratio` are accepted under
  exactly those names, and whether the returned URL expires. `npm run grok-probe` settles it.

### 3.1a Image EDITING — a different endpoint

Corrected 21 September 2026, after the first implementation got this wrong. Transforming a picture
someone supplied is **not** the generations call with an extra field:

```
POST /v1/images/edits
{ "model": "grok-imagine-image-2.0",
  "prompt": "Transform this hand-drawn architectural pencil sketch into …",
  "image": { "url": "data:image/jpeg;base64,…", "type": "image_url" },
  "resolution": "2K" }
```

- **One** source image per request. More than one is not combined; the rest go unused.
- **No `aspect_ratio`.** An edit keeps the source's proportions, and `resolution` (`1K` or `2K`)
  only sets the tier. This is the right behaviour for a sketch: the drawing's proportions are the
  building's.
- The response carries the picture at the top level rather than in a `data` array, so the connector
  reads `data[0]`, `image` and the root, and takes whichever arrived.
- This is the path that matters most in practice: "turn this sketch into a visualisation" is an edit,
  and sending it to the generation endpoint gets a picture loosely *inspired by* the sketch instead
  of that building, built. Verify it with `npm run grok-probe -- --edit your-sketch.jpeg`.

### 3.2 Video — asynchronous, two steps

```
POST /v1/videos/generations   →  { "request_id": "d97415a1-…" }
GET  /v1/videos/{request_id}  →  { "status": "pending" | "done" | "failed" | "expired", … }
```

Done:

```json
{ "status": "done",
  "video": { "url": "https://vidgen.x.ai/…/video.mp4", "duration": 8, "respect_moderation": true },
  "model": "grok-imagine-video-1.5" }
```

Failed: `{ "status": "failed", "error": { "code": "invalid_argument", "message": "…" } }`

Request fields: `model`, `prompt`, `image` (image-to-video, URL or base64), `duration` (1–15s),
`aspect_ratio` (`1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3`), `resolution` (`480p` default, `720p`,
`1080p` on 1.5 for text/image modes only), `generate_audio` (**defaults to true**),
`reference_images`, `reference_audios` (max 3 preset voices), `last_frame` (1.5).

> The completed URL is temporary. Download it into our own storage the moment the job reports done,
> or the link in a conversation from last Tuesday is dead.

### 3.3 Prices

| Model | Price |
|---|---|
| `grok-imagine-image` | $0.02 / image |
| `grok-imagine-image-2.0` (recommended) | $0.04 / image |
| `grok-imagine-image-quality` | $0.05 / image |
| `grok-imagine-video` | $0.050 / second |
| `grok-imagine-video-1.5` (recommended) | $0.080 / second |

A 15-second video on 1.5 is **$1.20**. For comparison, a Gemini Pro board is $0.18 and an
assistant answer is fractions of a cent. Video is the most expensive single action in the app by an
order of magnitude, which is why §10 asks the studio for a ceiling before this ships.

---

## 4. The constraints that decide the design

| Constraint | Value | Consequence |
|---|---|---|
| Serverless function cap | 60s (`vercel.json`) | No request may wait for a video. Full stop. |
| Assistant turn budget | `ASSISTANT_BUDGET_MS` = 40s | A tool that blocks for a minute loses the whole answer |
| API response relay cap | `MAX_RELAY_BYTES` = **4.3 MB** on Vercel (`fileTokens.ts:125`) | An mp4 cannot be served through `GET /api/assistant/file`. Video needs a signed storage URL |
| Tool-list token budget | `AI_TOKEN_BUDGET` = 5,000, and `estimateTokens` counts the tools | Two verbose new tool descriptions shrink the output clamp on *every* turn. Keep them tight |
| Tool cache breakpoint | `CACHED_TOOLS` marks `TOOLS[TOOLS.length - 1]` (`assistant.ts:875`) | Appending tools is fine and stays automatic — expect one cold cache write after deploy |
| Upload type allowlist | `UPLOAD_TYPES` + `sniffType` (`uploads.ts`) | Both need an mp4 branch, or a stored video is rejected |
| Permissions | `canWith(ctx.permissions, ctx.role, 'prompts', 'update')` | Reuse `prompts`; a new resource means touching `RESOURCES`, migration 0004 defaults **and** the override table |

**The single most important consequence:** images can finish inside a turn, videos cannot. So both
go through one job record, and images simply take a fast path when they beat the clock. That gives
the browser exactly one thing to poll and the answer exactly one shape to describe.

---

## 5. Design

### 5.1 New provider module — `apps/api/src/services/grok.ts`

Provider-shaped, the way `images.ts` says a provider module should be: prompt in, references in,
media out. Nothing Grok-specific leaks past its exports.

```ts
const XAI_URL = 'https://api.x.ai/v1';

/** Bounded well inside what remains of the assistant's 40s turn. */
const IMAGE_TIMEOUT_MS = Number(process.env.XAI_IMAGE_TIMEOUT_MS || 25_000);
/** The START call only — it returns a request_id, not a video. */
const START_TIMEOUT_MS = Number(process.env.XAI_START_TIMEOUT_MS || 15_000);

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  model: string;
  note: string | null;
}

export interface VideoRequest {
  prompt: string;
  /** Image-to-video: animate this still. Base64, from a file grant. */
  image?: { mimeType: string; bytes: Buffer } | null;
  seconds?: number;            // clamped 1..MAX_SECONDS
  aspectRatio?: string;        // '16:9' default
  resolution?: '480p' | '720p' | '1080p';
  withAudio?: boolean;         // default FALSE here — see §7
}

export class GrokNotConfigured extends Error {}

export async function isGrokReady(orgId?: string | null): Promise<boolean>;
export async function generateImage(req, refs, ctx: CallContext): Promise<GeneratedImage>;
export async function startVideo(req: VideoRequest, ctx: CallContext): Promise<{ requestId: string; model: string }>;
export async function pollVideo(requestId: string, orgId?: string | null): Promise<
  | { status: 'pending' }
  | { status: 'done'; url: string; seconds: number; model: string }
  | { status: 'failed' | 'expired'; message: string }
>;
```

Rules this module holds:

- Every failure that a person should read becomes a plain sentence, the way `images.ts` turns
  Gemini's rate-limit wording into "the image account has no quota left". A 401 is "the Grok key in
  Settings is not valid"; a moderation refusal is "Grok would not draw that", not a 400 body.
- **Cost is recorded on the call that spends it**: the image call records one image; the *poll* that
  first sees `done` records the video at `seconds × rate`. A failed or expired video records $0 and
  `ok: false`, so the spend report still shows the attempt (same rule as a failed board render).
- No provider SDK. `fetch` with an `AbortController`, exactly like `callGemini`, so the dependency
  tree does not grow and the timeout is ours.

### 5.2 Registries and settings

`packages/shared/src/index.ts`

```ts
// Added to IMAGE_MODELS — the same list the studio already picks from:
{ id: 'grok-imagine-image-2.0', label: 'Grok Imagine 2.0', usdPerImage: 0.04, kind: 'raster',
  note: 'Photoreal renderings and concept imagery. Fast, and a quarter of the price of Gemini Pro.' },

export interface VideoModel { id: string; label: string; usdPerSecond: number; maxSeconds: number; note: string }
export const VIDEO_MODELS: VideoModel[] = [
  { id: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5', usdPerSecond: 0.08, maxSeconds: 15, note: '…' },
  { id: 'grok-imagine-video',     label: 'Grok Imagine Video',     usdPerSecond: 0.05, maxSeconds: 15, note: '…' },
];
export const DEFAULT_VIDEO_MODEL = 'grok-imagine-video-1.5';
export function videoCostUsd(model: string, seconds: number): number;
```

`AiFeature` gains **`'video.render'`** (images through Grok stay on `'image.render'` — it is the same
job with a different supplier, and splitting it would break the comparison on the spend report).
`AI_FEATURES`, `AI_FEATURE_LABELS` and `AI_FEATURE_TRIGGER` are exhaustive records, so TypeScript
will name all three if one is forgotten. Label: "Video"; trigger: `'person'`.

`apps/api/src/env.ts`

```ts
xai: {
  apiKey: optional('XAI_API_KEY'),
  imageModel: optional('XAI_IMAGE_MODEL', 'grok-imagine-image-2.0'),
  videoModel: optional('XAI_VIDEO_MODEL', 'grok-imagine-video-1.5'),
},
```

`apps/api/src/lib/aiSettings.ts` — a third resolver beside `resolveAi` and `resolveImageAi`, with
its own cache and its own encrypted field:

```
xai_api_key_encrypted · xai_image_model · xai_video_model
```

Same AES-256-GCM `encrypt`/`decrypt`, same 30s TTL cache, same `invalidate…` on save, same
`…SettingsView` returning only the last four characters of the key. The key must never reach the
browser: `organizations.settings` is readable by every member of the studio.

### 5.3 Video jobs — migration `0014_media_jobs.sql`

```sql
create table if not exists media_jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  user_id       uuid not null references profiles(id) on delete cascade,
  kind          text not null check (kind in ('image','video')),
  status        text not null default 'pending'
                check (status in ('pending','done','failed','expired')),
  provider      text not null default 'xai',
  model         text not null,
  request_id    text,                  -- the provider's id, for polling
  prompt        text not null,
  project_id    uuid references projects(id) on delete set null,
  seconds       numeric,               -- what was asked for, then what was billed
  storage_path  text,                  -- assistant-uploads, once fetched
  mime_type     text,
  bytes         bigint,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  polled_at     timestamptz
);
create index if not exists idx_media_jobs_org    on media_jobs(org_id, created_at desc);
create index if not exists idx_media_jobs_status on media_jobs(status) where status = 'pending';

alter table media_jobs enable row level security;
drop policy if exists media_jobs_org_all on media_jobs;
create policy media_jobs_org_all on media_jobs
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());
```

The policy matches the generic org-scoped one the baseline applies in its loop
(`0001_baseline.sql:368`). Apply with `npm run db:apply`.

> **Known obstacle:** `SUPABASE_DB_URL` in this repo's `.env` holds the project URL, not a Postgres
> URI, so `npm run db:apply` cannot connect as-is. The migration will have to be applied through the
> Supabase SQL editor, or the real connection string obtained first. Budget time for that.

Lifecycle:

```
  start ──▶ pending ──▶ done      (bytes in storage, grant mintable)
              │  └────▶ failed    (provider said no; error carries the sentence)
              └───────▶ expired   (provider dropped it, or we gave up after ~10 min)
```

### 5.4 Who polls

Two pollers, because neither alone is enough:

1. **The browser, while someone is watching.** `GET /api/assistant/media/:id` → the job row, and,
   when it is still pending, that endpoint polls the provider once, fetches the mp4 into storage on
   the first `done`, and returns the finished row. One provider poll per browser poll, every 5s,
   capped. This is what makes the video appear in the conversation without a page reload.
2. **A cron sweep, for everyone who closed the tab.** A new `cronRouter.all('/media')` in
   `routes/ops.ts` finishes pending jobs older than a few seconds and expires anything past 10
   minutes. Registered in `vercel.json` `crons` at `*/5 * * * *`, and picked up by
   `services/scheduler.ts` when self-hosted. Without this, a person who asks for a video and walks
   away loses it — the provider's URL expires and nothing ever fetched the bytes.

Both paths call one function, `finishJob(jobId)`, so there is a single place that fetches, stores
and records cost. Concurrent pollers are made safe by a conditional update
(`status = 'pending'` in the `where`), so the second caller finds the work already done.

### 5.5 Delivery to the browser

**Image** — nothing new. Store to `assistant-uploads`, seal an upload grant with
`UPLOAD_GRANT_TTL_MS`, hand back `{ kind: 'file', preview: 'image', file: {…} }`. It is byte-for-byte
the `render_board` path at `assistant.ts:2440`.

**Video** — cannot use that path: 4.3 MB relay cap versus an mp4. So:

- `packages/shared/src/index.ts` — `AssistantItem.preview` gains `'video'`, and `AssistantFile`
  gains `streamUrl?: string | null`.
- The server fills `streamUrl` from `supabaseAdmin.storage.from('assistant-uploads')
  .createSignedUrl(path, 3600)` — a short-lived URL on Supabase's own origin. Not our origin, so no
  blob-URL-executes-as-the-app concern; and not the provider's temporary URL, so it keeps working.
- `AssistantAnswer.tsx` gains a `VideoPreview` branch beside `PagePreview`: a `<video controls
  preload="metadata" playsInline>` pointed at `streamUrl`. **Never `autoplay`**, and `muted` by
  default (§7). Download still goes through the normal relay, which will refuse anything over the
  cap with the message it already has — acceptable, because the signed URL is the way to see it.
- `uploads.ts` — add `'video/mp4'` to `UPLOAD_TYPES`, and an mp4 branch to `sniffType` (the `ftyp`
  box at offset 4). Keep sniffing from bytes; the provider's `Content-Type` is not the authority here
  any more than a browser's is.

### 5.6 Jenny's tool surface

Two tools appended to `TOOLS` in `apps/api/src/services/assistant.ts`, plus an entry each in
`TOOL_STATUS` (line 880) and `TOOL_SOURCES` (line 829).

```ts
{
  name: 'make_image',
  description:
    "MAKE a picture from a brief — a rendering, a concept image, a styled shot. Use when someone " +
    "asks to see something that is not one of the studio's presentation boards; for a board, use " +
    "render_board instead. Anything attached becomes reference imagery. Put the ref it returns in " +
    "the answer's items so the picture is shown.",
  input_schema: {
    type: 'object',
    properties: {
      brief: { type: 'string', description: 'What to draw, as you would brief a photographer: room, materials, light, camera.' },
      aspect_ratio: { type: 'string', description: '16:9, 1:1, 9:16, 4:3. Default 16:9.' },
      project_id: { type: 'string', description: 'The project this belongs to, so it is filed against it.' },
    },
    required: ['brief'],
  },
},
{
  name: 'make_video',
  description:
    "START a short video (up to 15 seconds) from a brief, or animate an attached still. It does NOT " +
    "finish inside this answer: it returns a job, and the person is shown it when it is ready. Say " +
    "that plainly — 'it is rendering, about a minute' — and never claim the video is done. Costs " +
    "roughly a dollar a clip, so confirm the brief before starting a second one.",
  input_schema: {
    type: 'object',
    properties: {
      brief:           { type: 'string' },
      seconds:         { type: 'number', description: '1 to 15. Default 6. Longer costs proportionally more.' },
      aspect_ratio:    { type: 'string' },
      from_attachment: { type: 'boolean', description: 'Animate the still the person attached, rather than drawing from words.' },
      project_id:      { type: 'string' },
    },
    required: ['brief'],
  },
},
```

Handlers, in `runTool`:

- `make_image` — permission check (`prompts`/`update`), `isGrokReady` check with the same
  "not set up yet, offer to do it another way" refusal wording `render_board` uses, read attachments
  via `fetchGrantedFile` into references, call `generateImage`, `storeUpload`, seal a grant, insert a
  `media_jobs` row with `status = 'done'` for the record, return a `refs.add('F', …)` ref.
- `make_video` — same checks, then `startVideo`, then insert the `pending` job and return
  **no ref at all**:

```ts
return {
  job_id: job.id,
  status: 'rendering',
  seconds,
  estimated_cost_usd: videoCostUsd(model, seconds).toFixed(2),
  instruction: 'Tell them it is rendering and roughly how long. Do NOT put a file ref in the items — ' +
               'there is no video yet. The screen shows it when it arrives.',
};
```

The `instruction` field is doing real work there: this is a model that will happily announce a
finished video it has never seen. The same defensive move as `ProducedWork` at `assistant.ts:271`,
from the other direction — there, the server delivers work the model forgot; here, the server
withholds a result the model would otherwise invent.

The web client puts the returned `job_id` in its conversation state and polls
`/api/assistant/media/:id` until it is `done`, then appends the video to that answer's items. The
plumbing for "an answer's items change after the fact" does not exist yet in
`apps/web/src/context/AssistantContext.tsx` and is the largest single piece of front-end work here.

### 5.7 Routes

| Route | Purpose |
|---|---|
| `GET /api/assistant/media/:id` | One job, polled; finishes it if the provider is ready |
| `GET /api/assistant/media` | This person's recent jobs, so a reopened conversation catches up |
| `POST /api/ops/cron/media` | The sweep (shared-secret guarded, like the other cron routes) |
| `POST /api/settings/media/key` · `/media/model` | The Grok key and model, principal-only, audited to `activity_log` like `settings.ai_model_set` |

---

## 6. File-by-file checklist

**API**

- [ ] `apps/api/src/services/grok.ts` — new. The provider.
- [ ] `apps/api/src/services/mediaJobs.ts` — new. `startVideoJob`, `finishJob`, `sweepJobs`, `jobView`.
- [ ] `apps/api/src/services/assistant.ts` — two tool definitions, two `runTool` cases, `TOOL_STATUS`, `TOOL_SOURCES`.
- [ ] `apps/api/src/routes/assistant.ts` — `GET /media/:id`, `GET /media`.
- [ ] `apps/api/src/routes/ops.ts` — `cronRouter.all('/media', …)`.
- [ ] `apps/api/src/routes/settings.ts` — key + model endpoints (and wire the orphaned image ones while there).
- [ ] `apps/api/src/lib/aiSettings.ts` — `resolveXai`, save/clear, `xaiSettingsView`, cache + invalidation.
- [ ] `apps/api/src/lib/uploads.ts` — `video/mp4` in `UPLOAD_TYPES`, mp4 branch in `sniffType`.
- [ ] `apps/api/src/services/scheduler.ts` — the sweep on the self-hosted timer.
- [ ] `apps/api/src/env.ts` — `env.xai`, `isGrokConfigured()`.

**Shared**

- [ ] `packages/shared/src/index.ts` — Grok entry in `IMAGE_MODELS`; `VideoModel` / `VIDEO_MODELS` /
      `DEFAULT_VIDEO_MODEL` / `videoCostUsd`; `'video.render'` in `AiFeature` and the three records;
      `preview: 'video'`; `AssistantFile.streamUrl`; a `MediaJob` view type.

**Database**

- [ ] `supabase/migrations/0014_media_jobs.sql`

**Web**

- [ ] `apps/web/src/components/AssistantAnswer.tsx` — `VideoPreview`, routed from `preview === 'video'`.
- [ ] `apps/web/src/context/AssistantContext.tsx` — track pending jobs, poll, append the finished item.
- [ ] `apps/web/src/components/AssistantChat.tsx` — a "rendering…" row with elapsed time and a cancel.
- [ ] `apps/web/src/lib/queries.ts` / `api.ts` — the media endpoints.
- [ ] `apps/web/src/pages/Settings.tsx` — the Grok key + model panel, beside the Claude one at line 131.
- [ ] `apps/web/src/pages/UsageReport.tsx` — check the video row reads sensibly (it is priced per
      second, and `input_tokens` are 0).

**Config / docs**

- [ ] `.env.example` — `XAI_API_KEY`, `XAI_IMAGE_MODEL`, `XAI_VIDEO_MODEL`, the two timeouts, `MEDIA_MAX_SECONDS`.
- [ ] `vercel.json` — the `*/5 * * * *` media cron.
- [ ] `scripts/grok-probe.mjs` — new. See M1.
- [ ] `docs/PROJECT-FLOW.md` — the new runtime path.

---

## 7. Voice, end to end

The voice half is largely **already built**, which is worth saying plainly before anyone plans work
for it. `apps/web/src/lib/speech.ts` holds recognition (`listen`, `hearingsOf`, `pauseFor`), the
studio's vocabulary re-ranking (`bestHearing`, fed by `GET /api/assistant/vocabulary`), echo
suppression (`soundsLikeEcho`) and speech output (`speak`, `speakable`). Every hearing already
reaches the server as `spoken.alternatives`, and the system prompt already tells the model the
question was spoken and to read the alternatives.

So the spoken path is: **hold the mic → "make me a six second walk-through of the Casa Elar
kitchen, morning light" → `listen` returns the hearings → `POST /ask` with `spoken.alternatives` →
Claude picks `make_video` → the job starts → Jenny says one sentence → the video appears.**

Four things to get right, all of them small and all of them easy to miss:

1. **A brief is not a query.** `bestHearing` re-ranks toward hearings containing real studio names,
   which is right for "what's late on Casa Elar" and neutral for "warm morning light across oak".
   Keep the winning hearing as the brief, but pass the alternatives through — a misheard material is
   a wasted dollar, and the model is better placed to spot "oat flooring" than the recogniser is.
2. **Never read a brief back aloud in full.** The `speech` field on the answer is a separate string
   for exactly this reason. For a video it should be one sentence — "Rendering it now, about a
   minute" — and for an image, "Here it is." Not the prompt.
3. **`generate_audio` defaults to true at the provider, and must default to false here.** A video
   that starts talking while Jenny is speaking is two voices at once, and `soundsLikeEcho` will then
   feed the video's own soundtrack back as the next question. Pass `generate_audio: false` unless
   someone explicitly asks for sound, and keep the `<video>` element `muted` with no autoplay.
4. **Confirm before spending.** A misheard sentence that raises a task is recoverable — that is why
   writes are proposals. A misheard sentence that renders a $1.20 video is not. Either route
   `make_video` through the existing proposal mechanism (`propose_*` → `respond_to_proposal`), or
   have the model read the brief back and start only on a yes. **Recommended: the proposal
   mechanism**, because it already exists, already has a Confirm button, and is already the pattern
   the codebase uses for "a voice mistake must not do this silently".

---

## 8. Milestones

Each one ends somewhere the work can stop safely.

**M1 — Provider proved (half a day).** `scripts/grok-probe.mjs`: generate one image, start one
video, poll it to `done`, print every raw response. This settles the field names §3.1 leaves open
and confirms the account is billable. `env.xai` and the registries land with it. Nothing is wired
into the app. *Done when: the script prints an mp4 URL and an image, and the exact response shapes
are recorded in this document.*

**M2 — Images through Grok (one day).** `grok.ts` image path, `make_image`, the settings resolver,
the key/model endpoints and the Settings panel. *Done when: "draw me the kitchen in warm oak" in the
Jenny panel returns a picture inline, and the spend shows on the usage report at $0.04.*

**M3 — Video jobs, server side (one to two days).** Migration 0014, `mediaJobs.ts`, the video path
in `grok.ts`, `make_video`, the media routes, the cron sweep. *Done when: a video job started by
curl reaches `done`, the mp4 is in the bucket, the cost is on the report, and a job abandoned by its
browser still completes via the sweep.*

**M4 — Video in the conversation (one day).** `preview: 'video'`, `streamUrl`, `VideoPreview`,
job polling and late item insertion in `AssistantContext`. *Done when: asking for a video in the
panel shows a "rendering" row that turns into a playable clip without a reload.*

**M5 — Voice and guardrails (half a day).** The confirm-before-spending step, the speech wording,
`generate_audio: false`, the per-studio second/spend ceiling, the AI-generated caveat on any
client-facing item. *Done when: the four points in §7 hold, and a spoken request for a video asks
for confirmation before it spends.*

---

## 9. Verification

There is no test runner in this repo, so verification is the build plus a scripted probe plus a
walk-through. All of it should pass before each milestone is called done.

```bash
npm run typecheck                 # the exhaustive AiFeature records catch most omissions
npm run build                     # shared → api → web, in that order
node scripts/grok-probe.mjs       # the provider, against the real key
npm run db:status                 # migration 0014 applied (see the SUPABASE_DB_URL caveat, §5.3)
npm run dev                       # then the walk-through below
```

Walk-through, in the Jenny panel: type an image brief; speak the same brief; speak a video brief and
confirm it; close the tab mid-render and reopen it; check the usage report shows one image and one
video with sensible money; attach a photo and ask for it to be animated; remove the Grok key and
confirm both tools refuse in words rather than failing oddly.

---

## 10. Risks, and what the studio has to decide

| # | Question for the studio | Why it blocks something |
|---|---|---|
| 1 | **A monthly ceiling on video spend, and a per-clip second cap?** | At $0.08/s, fifteen clips a day is $270/month. Recommend defaulting `MEDIA_MAX_SECONDS` to 8 and adding a soft monthly cap read from the same `activity_log` rows the usage report uses |
| 2 | **Who may render — everyone, or the principal and designers?** | Decides whether `prompts:update` is reused (no migration) or a `media` resource is added (migration + defaults + overrides) |
| 3 | **Sound on videos, ever?** | Default off is safer and cheaper; if the studio wants narrated walk-throughs, `reference_audios` and the voice collision in §7 need real design |
| 4 | **How long are videos kept?** | An mp4 is two orders of magnitude larger than a board. Storage will grow. Recommend a 90-day sweep on `media_jobs`, matching the upload grant's own month-long life |
| 5 | **Does anything client-facing need marking as AI-generated?** | An interiors studio showing a client a generated "photo" of their kitchen is a real expectation-management problem, not a technical one. Recommend a caveat line on every generated item and a visible label on anything exported |

**Technical risks**

- *The image API's exact field names are unconfirmed* (§3.1). M1 exists to close this before anything
  depends on it.
- *`SUPABASE_DB_URL` is not a Postgres URI in this repo's `.env`*, so migration 0014 may have to go
  through the Supabase SQL editor.
- *The 4.3 MB relay cap* means the download button will refuse larger videos; the signed URL is the
  real delivery path and must work, not be a fallback.
- *Two verbose tool descriptions cost tokens on every single assistant turn* (`AI_TOKEN_BUDGET`
  = 5,000, and `estimateTokens` counts the tool block). Keep them as tight as the sketches in §5.6.
- *Provider moderation refusals will happen* on interiors briefs less often than on most subjects,
  but `respect_moderation` and `error.code` need to reach the person as a sentence.

**Rollback.** Everything here is behind the absence of a key: with no `XAI_API_KEY` and no studio
Grok key, `isGrokReady` is false, both tools refuse in words, and the app behaves exactly as it does
today. That is the feature flag, and it is the same one `render_board` already uses.
