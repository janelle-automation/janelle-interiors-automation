import { supabaseAdmin } from '../lib/supabase.js';
import { isGoogleAuthFailure, orgSourceUserId } from '../lib/tokens.js';
import {
  gmailFor, getEmail, listMessageIds, downloadAttachment, addressOf, addressesOf,
  getProfileEmail, ignoredSenderQuery, isIgnoredSender, linksIn,
} from './gmail.js';
import { driveFor, listPdfs, downloadFile } from './drive.js';
import { classifyEmail } from './extract.js';
import { extractPdf, MAX_PDF_BYTES } from './extract.js';
import { draftReply, REPLYABLE } from './reply.js';
import {
  autoMergeDuplicates, namesAProject, promoteDocument, promoteEmail, removeVendorProjects,
} from './promote.js';
import { createTaskFromEmail, mergeDuplicateTasks } from './tasks.js';
import { isAiReady } from './anthropic.js';
import { readIngestSettings } from '../lib/ingestSettings.js';
import { bodyColumnsReady, bodyFields, readStoredText } from '../lib/emailStore.js';

export interface IngestResult {
  ok: boolean;
  reason?: string;
  emails: number;
  documents: number;
  replies: number;
  tasks: number;
  /** Machine mail dropped before it cost anything — see isIgnoredSender. */
  skipped: number;
  /** False when the time budget ran out before the queue was empty. */
  done: boolean;
  /** Best-effort count of what was left untouched when the budget ran out. */
  remaining: number;
}

export interface IngestOptions {
  emailQuery?: string;
  folderId?: string;
  /**
   * How long this pass may run before it stops and reports what is left.
   * Defaults to DEFAULT_BUDGET_MS.
   */
  budgetMs?: number;
}

/**
 * How long one pass runs before it hands back a partial result.
 *
 * Reading one email costs up to three Claude calls (classify, raise a task,
 * draft a reply) plus one per PDF attachment, so a full 25-message batch
 * takes minutes. On Vercel the function is killed at `maxDuration` (60s in
 * vercel.json) with a 504 FUNCTION_INVOCATION_TIMEOUT and the caller gets
 * nothing back — not even the emails already written. Stopping a little
 * short of that turns the timeout into a partial, resumable success: the
 * dedupe checks below skip whatever the previous pass stored, so the next
 * call picks up exactly where this one left off.
 *
 * Kept well under the function's maxDuration (60s) rather than close to it,
 * for two reasons: the deadline is only checked between items, so the item
 * in flight still has to finish; and a request held open for most of a
 * minute is the one an intermediary drops in transit, which reaches the
 * browser as a bare "Failed to fetch" with no status at all. Short passes
 * answer quickly and the caller simply asks again.
 */
const DEFAULT_BUDGET_MS = Number(process.env.INGEST_BUDGET_MS || 20_000);

/**
 * How much of a message body to keep.
 *
 * Gmail's own fetch already truncates at 12k; this is the storage cap. Long
 * enough to hold a real message and its quoted thread, short enough that a
 * studio's inbox does not become the largest thing in the database.
 */
const MAX_BODY_CHARS = 12_000;

/** Case-insensitive best-effort match of a name hint to an existing row. */
async function resolveByName(
  orgId: string,
  table: 'projects' | 'vendors',
  hint: string | null,
): Promise<string | null> {
  if (!hint || !supabaseAdmin) return null;
  const nameCol = table === 'projects' ? 'name' : 'name';
  const { data } = await supabaseAdmin
    .from(table)
    .select(`id, ${nameCol}, ${table === 'projects' ? 'client_name' : 'name'}`)
    .eq('org_id', orgId);
  if (!data) return null;
  const needle = hint.toLowerCase();
  const hit = data.find((row: Record<string, unknown>) => {
    const a = String(row[nameCol] ?? '').toLowerCase();
    const b = String((row as Record<string, unknown>).client_name ?? '').toLowerCase();
    return (a && needle.includes(a)) || (a && a.includes(needle)) || (b && needle.includes(b));
  });
  return (hit as { id?: string })?.id ?? null;
}

/**
 * Ingest recent Gmail + Drive activity for an org into Supabase.
 * Requires the org's source user to have Google connected, and the
 * Claude API configured. Safe to call repeatedly (dedupes by id), and
 * safe to stop early — see DEFAULT_BUDGET_MS.
 */
// Process-wide lock: only one ingestion runs at a time, whether it was
// triggered by the scheduler or a manual "Read Gmail & Drive" click. This
// prevents concurrent runs from double-processing and creating duplicate
// drafts in the user's Gmail.
//
// Held as a start time rather than a boolean because a serverless instance
// killed mid-run never reaches the `finally`. A boolean would leave that
// instance answering "busy" to every later request that landed on it; a
// timestamp lets the lock expire.
const LOCK_TTL_MS = 5 * 60_000;
let ingestStartedAt = 0;

/** A result that carries nothing but the reason it did nothing. */
function nothing(reason: string): IngestResult {
  return { ok: false, reason, emails: 0, documents: 0, replies: 0, tasks: 0, skipped: 0, done: false, remaining: 0 };
}

export async function runIngest(
  orgId: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  if (!supabaseAdmin) return nothing('supabase_not_configured');

  // Reading email without Claude is a supported mode — the mail still
  // lands in the Inbox, it just arrives unclassified and raises nothing.
  // Only refuse when the studio wants AI and has not configured it.
  const { useAi } = await readIngestSettings(orgId);
  if (useAi && !(await isAiReady())) return nothing('anthropic_not_configured');
  if (ingestStartedAt && Date.now() - ingestStartedAt < LOCK_TTL_MS) return nothing('busy');

  const userId = await orgSourceUserId(orgId);
  if (!userId) return nothing('no_source_user');

  ingestStartedAt = Date.now();
  try {
    return await ingestInternal(orgId, userId, opts, useAi);
  } finally {
    ingestStartedAt = 0;
  }
}

/**
 * Fetch the body and links for mail that was read before they were stored.
 *
 * Costs nothing but Gmail calls — no Claude, no re-classification, no new
 * tasks or drafts. Every message already in the system keeps its
 * classification and its links; all that changes is that the text of what
 * was written is there to be read.
 *
 * Budgeted and resumable like a reading pass, because an inbox of several
 * hundred stored messages is more Gmail calls than one request should hold.
 */
export async function backfillEmailBodies(
  orgId: string,
  opts: { budgetMs?: number; limit?: number } = {},
): Promise<{ ok: boolean; reason?: string; filled: number; remaining: number; done: boolean }> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', filled: 0, remaining: 0, done: false };

  const userId = await orgSourceUserId(orgId);
  if (!userId) return { ok: false, reason: 'no_source_user', filled: 0, remaining: 0, done: false };

  let gmail: Awaited<ReturnType<typeof gmailFor>> = null;
  try {
    gmail = await gmailFor(userId);
  } catch (err) {
    if (isGoogleAuthFailure(err)) return { ok: false, reason: 'google_auth_failed', filled: 0, remaining: 0, done: false };
    throw err;
  }
  if (!gmail) return { ok: false, reason: 'gmail_not_connected', filled: 0, remaining: 0, done: false };

  const { data, error } = await supabaseAdmin
    .from('emails')
    .select(`id, gmail_id, extracted_json${(await bodyColumnsReady()) ? ', body_text' : ''}`)
    .eq('org_id', orgId)
    .not('gmail_id', 'is', null)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 200);
  if (error) return { ok: false, reason: error.message, filled: 0, remaining: 0, done: false };

  // Filtered here rather than in the query: where the body lives depends on
  // whether 0010 has been applied, and `is null` cannot ask about both.
  const pending = ((data ?? []) as unknown as {
    id: string; gmail_id: string;
    body_text?: string | null; extracted_json?: Record<string, unknown> | null;
  }[]).filter((row) => !readStoredText(row).body);
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

  let filled = 0;
  let index = 0;
  for (; index < pending.length; index++) {
    if (Date.now() >= deadline) break;
    const row = pending[index];
    try {
      const email = await getEmail(gmail, row.gmail_id);
      // The error MUST be checked. Without it a write rejected by Postgres
      // still counted as filled, and the run reported forty-eight bodies
      // stored when it had stored none — a report that is wrong is worse
      // than one that fails, because nobody goes looking.
      const { error: writeError } = await supabaseAdmin
        .from('emails')
        .update(
          await bodyFields(
            (email.body || email.snippet || '').slice(0, MAX_BODY_CHARS),
            linksIn(email.body || ''),
            row.extracted_json ?? null,
          ),
        )
        .eq('id', row.id);
      if (writeError) throw new Error(writeError.message);
      filled++;
    } catch (err) {
      if (isGoogleAuthFailure(err)) {
        return { ok: false, reason: 'google_auth_failed', filled, remaining: pending.length - index, done: false };
      }
      // A message deleted from Gmail since is not worth failing the run for.
      console.error('[backfill] body failed', row.gmail_id, (err as Error).message);
    }
  }

  return { ok: true, filled, remaining: pending.length - index, done: index >= pending.length };
}

async function ingestInternal(
  orgId: string,
  userId: string,
  opts: IngestOptions,
  useAi: boolean,
): Promise<IngestResult> {
  if (!supabaseAdmin) return nothing('not_configured');

  // Everything below stops at this deadline rather than at the platform's,
  // so the caller always gets a result instead of a 504.
  const budgetMs = Math.max(0, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const timeLeft = () => deadline - Date.now();

  // Items can only be stopped between them, so the deadline alone is not
  // enough: starting a 20s email at second 44 of a 45s budget still runs
  // the function past its limit. Keep how long the slowest item of each
  // kind took and stop once that no longer fits in what is left. Emails
  // and PDFs are measured apart because they cost very different amounts.
  const slowest = { email: 0, doc: 0 };
  const roomFor = (kind: 'email' | 'doc') => timeLeft() > slowest[kind];
  const timed = (kind: 'email' | 'doc', startedAt: number) => {
    slowest[kind] = Math.max(slowest[kind], Date.now() - startedAt);
  };

  let done = true;
  let remaining = 0;

  let emailCount = 0;
  let docCount = 0;
  let replyCount = 0;
  let taskCount = 0;
  let skippedCount = 0;

  // ── Emails ────────────────────────────────────────────────
  // Everything from here to the first message sits OUTSIDE the per-email
  // guard below, so a dead Google grant threw straight out of the request
  // and the studio saw nothing but "Server error". A revoked or rotated
  // OAuth client is not a server fault — it needs somebody to reconnect
  // Google — so it is reported as a reason, like every other precondition.
  let gmail: Awaited<ReturnType<typeof gmailFor>> = null;
  let selfEmail = '';
  try {
    gmail = await gmailFor(userId);
    if (gmail) selfEmail = await getProfileEmail(gmail);
  } catch (err) {
    if (isGoogleAuthFailure(err)) return nothing('google_auth_failed');
    throw err;
  }

  if (gmail) {
    // Read state is deliberately absent from this query. The studio reads
    // its mail in Gmail long before the system gets to it, so anything
    // scoped to `is:unread` would miss most of the work; what stops a
    // message being read twice is the gmail_id check below, not its being
    // marked read. A caller-supplied query is used exactly as given.
    const query = opts.emailQuery ?? `newer_than:3d -in:sent ${ignoredSenderQuery()}`;
    let ids: string[];
    try {
      ids = await listMessageIds(gmail, query, 25);
    } catch (err) {
      if (isGoogleAuthFailure(err)) return nothing('google_auth_failed');
      throw err;
    }
    for (const [index, id] of ids.entries()) {
      // Between messages is the only safe place to stop: the one in flight
      // may already have written an email row and a reply draft.
      if (!roomFor('email')) {
        done = false;
        remaining += ids.length - index;
        break;
      }
      const emailStarted = Date.now();
      try {
        const { data: existing } = await supabaseAdmin
          .from('emails')
          .select('id')
          .eq('org_id', orgId)
          .eq('gmail_id', id)
          .maybeSingle();
        if (existing) continue;

        const email = await getEmail(gmail, id);

        // Machinery, not studio work — a Slack invite, a bot's comment on a
        // pull request, a Dropbox sign-in notice. Dropped before the first
        // Claude call and never stored, so it costs nothing and never shows
        // up in the Inbox beside real vendor mail. The query above already
        // excludes these senders; this catches a custom query and anything
        // Gmail's own matching let through.
        if (isIgnoredSender(email.from)) {
          skippedCount++;
          continue;
        }

        // Every one of these is a Claude call. With reading turned off the
        // message is still stored, just unclassified and unlinked.
        const extracted = useAi ? await classifyEmail(email, { orgId }) : null;
        // Only look for a project when the hint actually names one. A hint
        // like "Samples" matches almost any project name and filed mail
        // that had nothing to do with the job against it.
        const projectHint = namesAProject(extracted?.project_hint, extracted?.vendor_hint)
          ? extracted?.project_hint ?? null
          : null;
        const projectId = await resolveByName(orgId, 'projects', projectHint);
        const vendorId = await resolveByName(orgId, 'vendors', extracted?.vendor_hint ?? null);

        const { data: emailRow } = await supabaseAdmin
          .from('emails')
          .insert({
            org_id: orgId,
            gmail_id: email.gmailId,
            thread_id: email.threadId,
            from_addr: email.from,
            to_addr: email.to,
            subject: email.subject,
            snippet: email.snippet,
            // Keep what was actually written. Without it the only record of
            // a message is Gmail's one-line preview plus whatever the
            // extraction happened to name, so a link or a number mentioned
            // in passing is lost the moment the pass finishes.
            ...(await bodyFields(
              (email.body || email.snippet || '').slice(0, MAX_BODY_CHARS),
              linksIn(email.body || ''),
              (extracted ?? null) as Record<string, unknown> | null,
            )),
            received_at: email.receivedAt,
            project_id: projectId,
            vendor_id: vendorId,
            class: extracted?.class ?? 'unclassified',
            confidence: extracted?.confidence ?? null,
          })
          .select('id')
          .maybeSingle();
        emailCount++;

        // Promote the email into vendor/project records where identifiable.
        if (emailRow) {
          await promoteEmail(orgId, {
            id: emailRow.id,
            class: extracted?.class ?? 'unclassified',
            vendor_id: vendorId,
            project_id: projectId,
            extracted_json: extracted ?? null,
          });
        }

        // Raise an internal task when the email implies work, assigned by
        // role. Isolated so an extraction failure never loses the email.
        if (emailRow && useAi) {
          try {
            const made = await createTaskFromEmail(
              orgId,
              emailRow.id,
              extracted?.class ?? 'unclassified',
              email,
            );
            if (made) taskCount++;
          } catch (err) {
            console.error('[ingest] task creation failed:', (err as Error).message);
          }
        }

        // Auto-draft a reply tailored to the email's type and content,
        // addressed to the real correspondent (not the forwarder) with CCs.
        if (emailRow && extracted && REPLYABLE.includes(extracted.class)) {
          try {
            // Exclude the connected account and — when this is a forward —
            // the forwarder's own address, so we never reply to ourselves.
            const isForward = /^(re:\s*)*(fwd:|fw:)/i.test(email.subject.trim());
            const forwarder = isForward ? addressOf(email.from || '') : '';
            const isMine = (a: string) => !a || a === selfEmail || a === forwarder;

            // Who to reply to: prefer the extracted counterparty, then the
            // Reply-To / From headers — skipping our own addresses.
            const toCandidates = [
              (extracted.reply_to_email ?? '').toLowerCase(),
              addressOf(email.replyTo || ''),
              addressOf(email.from || ''),
            ];
            const to = toCandidates.find((a) => a.includes('@') && !isMine(a));

            if (!to) {
              console.warn('[ingest] no external recipient for reply on', email.gmailId);
            } else {
              // Reply drafts are kept IN THE SYSTEM (not Gmail). Dedupe by
              // subject so re-ingests don't create a second copy.
              const subject = email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`;
              const { data: existingDraft } = await supabaseAdmin
                .from('drafts')
                .select('id')
                .eq('org_id', orgId)
                .eq('subject', subject)
                .limit(1)
                .maybeSingle();

              if (!existingDraft) {
                // CCs: everyone else on the correspondence, minus self and the recipient.
                const cc = [...new Set([...(extracted.cc_emails ?? []).map((c) => c.toLowerCase()), ...addressesOf(email.cc)])]
                  .filter((a) => a.includes('@') && !isMine(a) && a !== to);

                const reply = await draftReply(email, extracted.class);
                if (reply) {
                  const ccLine = cc.length ? `\nCc: ${cc.join(', ')}` : '';
                  const composed = `To: ${to}${ccLine}\n\n${reply.body}`;
                  await supabaseAdmin.from('drafts').insert({
                    org_id: orgId,
                    subject: reply.subject,
                    body_preview: composed,
                  });
                  replyCount++;
                }
              }
            }
          } catch (err) {
            console.error('[ingest] reply draft failed', email.gmailId, (err as Error).message);
          }
        }

        // Parse any PDF attachments (quotes / order confirmations) that
        // arrived on this email into the documents table. Reading a PDF is a
        // Claude call, so with AI off we skip the download too.
        for (const att of useAi ? email.attachments : []) {
          if (!roomFor('doc')) {
            // The email itself is stored, so the next pass skips it and
            // these attachments with it. Rare, and cheaper than a 504.
            done = false;
            break;
          }
          // Skip before downloading: the bytes alone are what put the
          // invocation at risk, and reading it would be refused anyway.
          if (att.size > MAX_PDF_BYTES) {
            console.warn('[ingest] attachment too large to read', att.filename, att.size);
            continue;
          }
          const attStarted = Date.now();
          try {
            const ref = `gmail:${email.gmailId}:${att.attachmentId}`;
            const { data: seen } = await supabaseAdmin
              .from('documents')
              .select('id')
              .eq('org_id', orgId)
              .eq('drive_file_id', ref)
              .maybeSingle();
            if (seen) continue;

            const pdf = await downloadAttachment(gmail, email.gmailId, att.attachmentId);
            const parsed = await extractPdf(pdf, att.filename);
            const { data: docRow } = await supabaseAdmin
              .from('documents')
              .insert({
                org_id: orgId,
                drive_file_id: ref,
                project_id: projectId,
                type: parsed?.type ?? 'other',
                parsed_json: parsed ?? null,
                confidence: parsed?.confidence ?? null,
              })
              .select('id')
              .maybeSingle();
            docCount++;
            if (docRow) {
              await promoteDocument(orgId, { id: docRow.id, type: parsed?.type ?? 'other', parsed_json: parsed ?? null, project_id: projectId });
            }
          } catch (err) {
            console.error('[ingest] attachment failed', att.filename, (err as Error).message);
          } finally {
            timed('doc', attStarted);
          }
        }
      } catch (err) {
        console.error('[ingest] email failed', id, (err as Error).message);
      } finally {
        timed('email', emailStarted);
      }
    }
  }

  // ── Drive documents (PDF quotes / confirmations) ──────────
  // Skipped entirely when the mail already used the budget; the next pass
  // finds the same files, minus whatever got stored.
  if (useAi && !roomFor('doc')) done = false;
  let drive: Awaited<ReturnType<typeof driveFor>> = null;
  try {
    drive = useAi && roomFor('doc') ? await driveFor(userId) : null;
  } catch (err) {
    // The mail is already written; losing Drive as well would be worse than
    // reporting an incomplete pass.
    if (!isGoogleAuthFailure(err)) throw err;
    console.error('[ingest] Drive unavailable — Google needs reconnecting');
    done = false;
  }
  if (drive) {
    const files = await listPdfs(drive, { folderId: opts.folderId, max: 15 });
    for (const [index, file] of files.entries()) {
      if (!roomFor('doc')) {
        done = false;
        remaining += files.length - index;
        break;
      }
      if (file.size > MAX_PDF_BYTES) {
        console.warn('[ingest] Drive file too large to read', file.name, file.size);
        continue;
      }
      const fileStarted = Date.now();
      try {
        const { data: existing } = await supabaseAdmin
          .from('documents')
          .select('id')
          .eq('org_id', orgId)
          .eq('drive_file_id', file.id)
          .maybeSingle();
        if (existing) continue;

        const bytes = await downloadFile(drive, file.id);
        const extracted = await extractPdf(bytes, file.name);
        const projectId = await resolveByName(
          orgId,
          'projects',
          namesAProject(extracted?.project_hint, extracted?.vendor) ? extracted?.project_hint ?? null : null,
        );

        const { data: docRow } = await supabaseAdmin
          .from('documents')
          .insert({
            org_id: orgId,
            drive_file_id: file.id,
            project_id: projectId,
            type: extracted?.type ?? 'other',
            parsed_json: extracted ?? null,
            confidence: extracted?.confidence ?? null,
          })
          .select('id')
          .maybeSingle();
        docCount++;
        if (docRow) {
          await promoteDocument(orgId, { id: docRow.id, type: extracted?.type ?? 'other', parsed_json: extracted ?? null, project_id: projectId });
        }
      } catch (err) {
        console.error('[ingest] document failed', file.id, (err as Error).message);
      } finally {
        timed('doc', fileStarted);
      }
    }
  }

  // Fold any projects this pass split in two before anyone sees them.
  // Only once the queue is clear: a half-read inbox is the worst moment to
  // decide two names are the same job, and the next pass will do it anyway.
  // Never fatal — the mail is already stored, and a tidy-up that failed
  // must not turn a good pass into an error.
  let mergedProjects = 0;
  let mergedTasks = 0;
  if (done) {
    try {
      mergedProjects = (await autoMergeDuplicates(orgId)).removed;
    } catch (err) {
      console.error('[ingest] merging duplicate projects failed:', (err as Error).message);
    }
    try {
      mergedTasks = (await mergeDuplicateTasks(orgId)).removed;
    } catch (err) {
      console.error('[ingest] merging duplicate tasks failed:', (err as Error).message);
    }
    try {
      // A vendor filed as a project too, from before the hint was gated.
      await removeVendorProjects(orgId);
    } catch (err) {
      console.error('[ingest] removing vendor-projects failed:', (err as Error).message);
    }
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'ingest.run',
    entity: 'ingest',
    meta: {
      emails: emailCount,
      documents: docCount,
      replies: replyCount,
      tasks: taskCount,
      skipped: skippedCount,
      done,
      remaining,
      mergedProjects,
      mergedTasks,
    },
  });

  return {
    ok: true,
    emails: emailCount,
    documents: docCount,
    replies: replyCount,
    tasks: taskCount,
    skipped: skippedCount,
    done,
    remaining,
  };
}
