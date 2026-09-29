import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { hasDraftOwner, hasDraftGmailMessage } from '../lib/columns.js';
import { asyncHandler } from '../middleware/error.js';
import {
  gmailForReply, createDraft, updateDraft, deleteDraft,
  type DraftContent, type DraftHandle,
} from '../services/gmail.js';

export const draftsRouter = Router();
draftsRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
draftsRouter.use(requirePermission('drafts', 'read'));

/** True when a body carries the rich-text editor's HTML rather than plain text. */
const looksHtml = (body: string) => /<(p|br|div|ul|ol|h\d|blockquote)\b/i.test(body);

/** A rich-text body, read back as the plain-text part every mail client can render. */
function plainTextFromHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Put a draft into the studio's actual Gmail Drafts — through the draft's
 * own owner when it has one (a reply living in a teammate's personal
 * mailbox), the studio's shared connection otherwise. Failure here (no
 * Google connection, an expired token, a quota error) must not fail the
 * save the person is sitting in front of — it only costs the "Open in
 * Gmail" link, which degrades to nothing rather than the save failing.
 */
async function pushToGmail(orgId: string | null, ownerId: string | null, content: DraftContent): Promise<DraftHandle | null> {
  try {
    const gmail = await gmailForReply(orgId, ownerId);
    return gmail ? await createDraft(gmail, content) : null;
  } catch (err) {
    console.error('[drafts] could not create the Gmail draft:', (err as Error).message);
    return null;
  }
}

async function updateInGmail(orgId: string | null, ownerId: string | null, draftId: string, content: DraftContent): Promise<DraftHandle | null> {
  try {
    const gmail = await gmailForReply(orgId, ownerId);
    return gmail ? await updateDraft(gmail, draftId, content) : null;
  } catch (err) {
    console.error('[drafts] could not update the Gmail draft:', (err as Error).message);
    return null;
  }
}

async function removeFromGmail(orgId: string | null, ownerId: string | null, draftId: string): Promise<void> {
  try {
    const gmail = await gmailForReply(orgId, ownerId);
    if (gmail) await deleteDraft(gmail, draftId);
  } catch (err) {
    console.error('[drafts] could not delete the Gmail draft:', (err as Error).message);
  }
}

// List drafts kept in the system (reply drafts, follow-up nudges, saved
// prompt output). Most also have a live Gmail draft behind them — see
// gmail_draft_id / gmail_message_id — which is what "Open in Gmail" opens.
draftsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const withGmailMessage = await hasDraftGmailMessage();
    const { data, error } = await req.auth!.db
      .from('drafts')
      .select(
        `id, subject, body_preview, follow_up_id, created_at, created_by, gmail_draft_id${
          (await hasDraftOwner()) ? ', owner_id' : ''
        }${withGmailMessage ? ', gmail_message_id' : ''}`,
      )
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Save a draft in the system from supplied text (e.g. Prompt Studio output).
draftsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const subject = String(req.body?.subject ?? 'Draft').trim();
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'Draft body is required' });

    const composed = to ? `To: ${to}\n\n${body}` : body;
    // Written by hand from scratch, not answering any mailbox in
    // particular — the studio's own connection is the only one that makes
    // sense here.
    const pushed = to ? await pushToGmail(req.auth!.orgId, null, { to, subject, body }) : null;

    const row: Record<string, unknown> = {
      org_id: req.auth!.orgId, subject, body_preview: composed, created_by: req.auth!.userId,
    };
    if (pushed) {
      row.gmail_draft_id = pushed.draftId;
      if (await hasDraftGmailMessage()) row.gmail_message_id = pushed.messageId;
    }

    const { data, error } = await req.auth!.db
      .from('drafts')
      .insert(row)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data: { id: data?.id } });
  }),
);

// Edit a draft's recipients, subject and body. The body may be HTML (from the
// rich-text editor); To / Cc stay as header lines so older readers still work.
// The edit is carried into the live Gmail draft too, so "Open in Gmail" never
// shows someone a stale version of what they just saved here.
draftsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const cc = String(req.body?.cc ?? '').trim();
    const subject = String(req.body?.subject ?? '').trim();
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'Draft body is required' });

    const headers = [to ? `To: ${to}` : null, cc ? `Cc: ${cc}` : null].filter(Boolean).join('\n');
    const composed = headers ? `${headers}\n\n${body}` : body;
    const withGmailMessage = await hasDraftGmailMessage();
    const withOwner = await hasDraftOwner();

    const { data: existing } = await req.auth!.db
      .from('drafts')
      .select(`gmail_draft_id${withOwner ? ', owner_id' : ''}`)
      .eq('id', req.params.id)
      .maybeSingle();
    const existingDraftId = (existing as { gmail_draft_id?: string | null } | null)?.gmail_draft_id;
    // Whose mailbox this reply actually lives in, so the edit reaches the
    // real draft instead of pushing a second, stray one through the
    // studio's shared connection.
    const ownerId = (existing as { owner_id?: string | null } | null)?.owner_id ?? null;

    let synced: DraftHandle | null = null;
    if (to) {
      const html = looksHtml(body) ? body : undefined;
      const content: DraftContent = {
        to, cc: cc || undefined, subject: subject || 'Draft',
        body: html ? plainTextFromHtml(html) : body,
        ...(html ? { html } : {}),
      };
      synced = existingDraftId
        ? await updateInGmail(req.auth!.orgId, ownerId, existingDraftId, content)
        : await pushToGmail(req.auth!.orgId, ownerId, content);
    }

    const update: Record<string, unknown> = { subject: subject || 'Draft', body_preview: composed };
    if (synced) {
      update.gmail_draft_id = synced.draftId;
      if (withGmailMessage) update.gmail_message_id = synced.messageId;
    }

    // A fixed column list, not the usual conditional select: the frontend
    // re-fetches the list on success anyway, so this response only needs
    // enough to log the edit below — it does not have to carry
    // gmail_message_id even when the column exists.
    const { data, error } = await req.auth!.db
      .from('drafts')
      .update(update)
      .eq('id', req.params.id)
      .select('id, subject, body_preview, follow_up_id, created_at, gmail_draft_id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Draft not found' });

    await req.auth!.db.from('activity_log').insert({
      org_id: req.auth!.orgId,
      actor: req.auth!.userId,
      action: 'draft.edit',
      entity: 'drafts',
      entity_id: data.id,
      meta: { subject: data.subject },
    });

    res.json({ data });
  }),
);

// Delete a draft (after sending it manually or dismissing it) — and the
// live Gmail draft behind it, so dismissing it here does not leave a stray
// copy sitting in the studio's real Drafts folder.
draftsRouter.delete(
  '/:id',
  requirePermission('drafts', 'delete'),
  asyncHandler(async (req, res) => {
    const withOwner = await hasDraftOwner();
    const { data: existing } = await req.auth!.db
      .from('drafts')
      .select(`gmail_draft_id${withOwner ? ', owner_id' : ''}`)
      .eq('id', req.params.id)
      .maybeSingle();

    const { error } = await req.auth!.db.from('drafts').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);

    const draftId = (existing as { gmail_draft_id?: string | null } | null)?.gmail_draft_id;
    const ownerId = (existing as { owner_id?: string | null } | null)?.owner_id ?? null;
    if (draftId) await removeFromGmail(req.auth!.orgId, ownerId, draftId);

    res.json({ data: { ok: true } });
  }),
);
