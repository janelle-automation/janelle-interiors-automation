import express, { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ask, type AssistantContext, type AssistantTurn, type PendingProposal } from '../services/assistant.js';
import { ProposalError, commitProposal } from '../services/proposals.js';
import { buildBriefing, emptyBriefing } from '../services/briefing.js';
import { MAX_RELAY_BYTES, UPLOAD_GRANT_TTL_MS, openFileGrant, sealFileGrant } from '../lib/fileTokens.js';
import { MAX_UPLOAD_BYTES, removeUploads, sniffType, storeUpload } from '../lib/uploads.js';
import { FileFetchError, fetchGrantedContent } from '../services/files.js';
import { STUDIO_TEAM, isStudioMailbox } from '../lib/studioTeam.js';

export const assistantRouter = Router();
assistantRouter.use(requireAuth);

/**
 * Who is asking, as the assistant should know them.
 *
 * The session carries an email, and the assistant used to be told that was
 * the person's name — so it greeted people by their address, and "my
 * tasks" matched nobody, because tasks are assigned to full names. The
 * profile's own name is read here, once per question.
 */
async function assistantContext(req: Request, page?: unknown, pending?: unknown): Promise<AssistantContext> {
  const { db, userId, orgId, role, seat, email, permissions } = req.auth!;
  let name = email ?? 'a teammate';
  try {
    const { data } = await db.from('profiles').select('full_name').eq('id', userId).maybeSingle();
    const full = (data as { full_name?: string | null } | null)?.full_name?.trim();
    if (full) name = full;
  } catch {
    // The email still identifies them; an unreadable profile is not worth failing over.
  }
  const path = (page as { path?: unknown } | undefined)?.path;
  return {
    db,
    userId,
    orgId,
    role,
    seat,
    name,
    permissions,
    page: typeof path === 'string' ? { path: path.slice(0, 300) } : null,
    pending: pendingFrom(pending),
  };
}

/**
 * What the person has been shown and not yet answered, as the browser holds it.
 *
 * Taken on trust only as far as trust costs nothing: anything saved from here
 * goes through commitProposal, the same checks as the Confirm button, which
 * the browser could already call with any input it liked.
 */
function pendingFrom(raw: unknown): PendingProposal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => typeof p.key === 'string' && ['propose_task', 'propose_task_update', 'propose_draft'].includes(String(p.tool)))
    .filter((p) => !!p.input && typeof p.input === 'object')
    .slice(0, 10)
    .map((p) => ({
      key: String(p.key).slice(0, 120),
      tool: String(p.tool),
      summary: String(p.summary ?? '').slice(0, 300),
      input: p.input as Record<string, unknown>,
    }));
}

// Ask the assistant a question. Read-only: any write it decides on comes
// back as a proposal for the person to confirm.
assistantRouter.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message is too long' });

    const raw = Array.isArray(req.body?.history) ? req.body.history : [];
    const history: AssistantTurn[] = raw
      .filter((t: unknown) => {
        const x = t as { role?: string; content?: string };
        return (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string';
      })
      .slice(-8);

    const ctx = await assistantContext(req, req.body?.page, req.body?.pending);
    // Spoken: every way the browser heard it, best first.
    const heard = (req.body?.spoken as { alternatives?: unknown } | undefined)?.alternatives;
    if (Array.isArray(heard)) {
      const alternatives = heard
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        .map((a) => a.trim().slice(0, 300))
        .slice(0, 5);
      if (alternatives.length) ctx.spoken = { alternatives };
    }
    // Files handed over earlier. Only tokens this server sealed for this
    // studio are kept; anything else in the list is dropped, silently.
    const granted = (list: unknown, max: number) =>
      (Array.isArray(list) ? (list as unknown[]) : [])
        .map((f) => (f as { token?: unknown })?.token)
        .filter((t): t is string => typeof t === 'string' && t.length < 6000)
        .slice(-max)
        .flatMap((token) => {
          const opened = openFileGrant(token, ctx.orgId);
          return opened.ok ? [{ token, grant: opened.grant }] : [];
        });
    ctx.recentFiles = granted(req.body?.files, 8);
    // Attached to this question by the person asking it.
    ctx.attached = granted(req.body?.attachments, MAX_ATTACHMENTS);

    if (req.query.stream !== '1') {
      res.json({ data: await ask(message, history, ctx) });
      return;
    }

    // Streamed as newline-delimited JSON: progress lines while she works,
    // then the result. A host that buffers the response still delivers
    // every line, just all at once at the end — the answer is the same, only
    // the progress is lost — so nothing depends on streaming actually working.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const line = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };

    // Headers are already sent, so a failure can no longer become an HTTP
    // status. It is reported in the stream instead, where the client reads it.
    try {
      const result = await ask(message, history, ctx, { onStatus: (text) => line({ type: 'status', text }) });
      line({ type: 'result', data: result });
    } catch (err) {
      console.error('[assistant] ask failed:', (err as Error).message);
      line({ type: 'error', error: (err as Error).message || 'Something went wrong' });
    }
    res.end();
  }),
);

/**
 * The words the studio uses that a speech recogniser does not know.
 *
 * "Denish", "Casa Elar", "Nordhaus" are not in any dictionary, so they are
 * heard as the nearest words that are. The browser uses this list to prefer
 * the hearing that contains a real name, and — where it supports phrase
 * hints — to listen for these names in the first place. Read with the
 * caller's own client: only names they could already see.
 */
assistantRouter.get(
  '/vocabulary',
  asyncHandler(async (req, res) => {
    const { db } = req.auth!;
    const [people, projects, vendors] = await Promise.all([
      db.from('profiles').select('full_name, email'),
      db.from('projects').select('name, client_name, status'),
      db.from('vendors').select('name'),
    ]);
    const tidy = (values: (string | null | undefined)[]) =>
      [...new Set(values.map((v) => (v ?? '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim()).filter((v) => v.length >= 2))].slice(0, 200);
    const projectRows = ((projects.data ?? []) as { name: string | null; client_name: string | null; status: string }[])
      .filter((p) => p.status !== 'archived');
    res.json({
      data: {
        // Every teammate the studio lists, account or not, by every spelling;
        // never the shared inbox's account name.
        people: tidy([
          ...((people.data ?? []) as { full_name: string | null; email: string | null }[])
            .filter((p) => !isStudioMailbox(p.email))
            .map((p) => p.full_name),
          ...STUDIO_TEAM.flatMap((p) => [p.name, ...(p.aliases ?? [])]),
        ]),
        projects: tidy(projectRows.map((p) => p.name)),
        clients: tidy(projectRows.map((p) => p.client_name)),
        vendors: tidy(((vendors.data ?? []) as { name: string | null }[]).map((v) => v.name)),
      },
    });
  }),
);

/**
 * What needs this person today, before they ask anything.
 *
 * `hour` is the person's local hour, because the server cannot know their
 * timezone and "Good evening" at breakfast is the kind of detail that makes
 * an assistant feel like a script.
 */
assistantRouter.get(
  '/briefing',
  asyncHandler(async (req, res) => {
    const ctx = await assistantContext(req);
    const hourRaw = Number(req.query.hour);
    const hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : null;
    if (!ctx.orgId) return res.json({ data: emptyBriefing(ctx.name, hour) });
    res.json({ data: await buildBriefing(ctx, { hour }) });
  }),
);

/**
 * Hand over a file the assistant found.
 *
 * The token is the whole authorisation: it was minted when the file was
 * shown to someone allowed to see it, it names exactly one attachment or
 * one Drive file, and it only opens for the organisation it was made for.
 * Nothing in the request can widen it to a different file.
 */
assistantRouter.get(
  '/file',
  asyncHandler(async (req: Request, res: Response) => {
    const opened = openFileGrant(String(req.query.token ?? ''), req.auth!.orgId);
    if (!opened.ok) {
      const message =
        opened.reason === 'expired'
          ? 'This file link has expired — ask again and a fresh one is made.'
          : 'This file link is not valid.';
      return res.status(opened.reason === 'expired' ? 410 : 403).json({ error: message });
    }
    const { grant } = opened;

    let file: Awaited<ReturnType<typeof fetchGrantedContent>>;
    try {
      file = await fetchGrantedContent(grant);
    } catch (err) {
      if (err instanceof FileFetchError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    const { bytes, name, mimeType, webUrl } = file;

    // Past what the platform will return, the person would get a bare
    // platform error instead of their file. Say so, and say where it is.
    if (bytes.length > MAX_RELAY_BYTES) {
      return res.status(413).json({
        error:
          grant.source === 'upload'
            ? `This file is too large to download here (${(bytes.length / (1024 * 1024)).toFixed(1)} MB).`
            : `This file is too large to download here (${(bytes.length / (1024 * 1024)).toFixed(1)} MB). Open it in ${grant.source === 'gmail' ? 'Gmail' : 'Drive'} instead.`,
        webUrl,
      });
    }

    // Always an attachment, never rendered inline, and never sniffed: the
    // file came from someone's inbox, and an HTML or SVG attachment served
    // inline from this origin would run as the app. The browser previews
    // only the types it chooses to, from a blob.
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }),
);

/** Files one question may carry. */
const MAX_ATTACHMENTS = 4;

/**
 * Attach a file to a question: a PDF or an image, sent as the raw request
 * body with its name in the query string.
 *
 * Returns a grant for it. The file is kept for the person's conversations —
 * its grant lasts a month — and read only when a question needs it.
 */
assistantRouter.post(
  '/upload',
  (req, res, next) => {
    // Refused before a byte is read: a body past the limit would otherwise
    // be buffered in full just to be thrown away.
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `That file is too large — the limit is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` });
    }
    next();
  },
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, userId } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No studio is attached to this account.' });

    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) return res.status(400).json({ error: 'The file is empty.' });
    const mimeType = sniffType(bytes);
    if (!mimeType) {
      return res.status(415).json({ error: 'Jenny can read PDFs and images (PNG, JPEG, GIF, WebP). Save other files as a PDF first.' });
    }

    const name = String(req.query.name ?? '').trim().slice(0, 200) || (mimeType === 'application/pdf' ? 'document.pdf' : 'image');
    let stored: { path: string };
    try {
      stored = await storeUpload({ orgId, userId, name, mimeType, bytes });
    } catch (err) {
      console.error('[assistant] upload failed:', (err as Error).message);
      return res.status(503).json({ error: 'The file could not be stored right now. Try again in a moment.' });
    }

    const token = sealFileGrant(
      { source: 'upload', orgId, path: stored.path, name, mimeType, size: bytes.length },
      UPLOAD_GRANT_TTL_MS,
    );
    res.json({ data: { token, name, mimeType, size: bytes.length } });
  }),
);

/**
 * Delete uploads — when their conversation is deleted. Only the person's own
 * files: a grant for someone else's upload is ignored, not refused, so a
 * conversation that mixes both still clears what it can.
 */
assistantRouter.post(
  '/uploads/forget',
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, userId } = req.auth!;
    const tokens = (Array.isArray(req.body?.tokens) ? (req.body.tokens as unknown[]) : [])
      .filter((t): t is string => typeof t === 'string' && t.length < 6000)
      .slice(0, 100);
    const paths = tokens.flatMap((token) => {
      const opened = openFileGrant(token, orgId);
      return opened.ok && opened.grant.source === 'upload' ? [opened.grant.path] : [];
    });
    const removed = orgId && paths.length ? await removeUploads(orgId, userId, paths) : 0;
    res.json({ data: { removed } });
  }),
);

// Commit a proposal the person confirmed with the button. Saying "yes" in
// the conversation reaches the same code through the assistant's
// respond_to_proposal tool, so both are checked and recorded alike.
assistantRouter.post(
  '/confirm',
  asyncHandler(async (req, res) => {
    const tool = typeof req.body?.tool === 'string' ? req.body.tool : 'propose_task';
    const input = (req.body?.input ?? {}) as Record<string, unknown>;
    try {
      res.json({ data: await commitProposal(req.auth!, tool, input, 'button') });
    } catch (err) {
      if (err instanceof ProposalError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }),
);
