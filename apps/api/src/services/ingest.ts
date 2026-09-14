import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { gmailFor, getEmail, listMessageIds, downloadAttachment, addressOf, addressesOf, getProfileEmail } from './gmail.js';
import { driveFor, listPdfs, downloadFile } from './drive.js';
import { classifyEmail } from './extract.js';
import { extractPdf } from './extract.js';
import { draftReply, REPLYABLE } from './reply.js';
import { promoteDocument, promoteEmail } from './promote.js';
import { createTaskFromEmail } from './tasks.js';
import { isAiReady } from './anthropic.js';
import { readIngestSettings } from '../lib/ingestSettings.js';

export interface IngestResult {
  ok: boolean;
  reason?: string;
  emails: number;
  documents: number;
  replies: number;
  tasks: number;
}

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
 * Claude API configured. Safe to call repeatedly (dedupes by id).
 */
// Process-wide lock: only one ingestion runs at a time, whether it was
// triggered by the scheduler or a manual "Read Gmail & Drive" click. This
// prevents concurrent runs from double-processing and creating duplicate
// drafts in the user's Gmail.
let ingestInFlight = false;

export async function runIngest(
  orgId: string,
  opts: { emailQuery?: string; folderId?: string } = {},
): Promise<IngestResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', emails: 0, documents: 0, replies: 0, tasks: 0 };

  // Reading email without Claude is a supported mode — the mail still
  // lands in the Inbox, it just arrives unclassified and raises nothing.
  // Only refuse when the studio wants AI and has not configured it.
  const { useAi } = await readIngestSettings(orgId);
  if (useAi && !(await isAiReady())) return { ok: false, reason: 'anthropic_not_configured', emails: 0, documents: 0, replies: 0, tasks: 0 };
  if (ingestInFlight) return { ok: false, reason: 'busy', emails: 0, documents: 0, replies: 0, tasks: 0 };

  const userId = await orgSourceUserId(orgId);
  if (!userId) return { ok: false, reason: 'no_source_user', emails: 0, documents: 0, replies: 0, tasks: 0 };

  ingestInFlight = true;
  try {
    return await ingestInternal(orgId, userId, opts, useAi);
  } finally {
    ingestInFlight = false;
  }
}

async function ingestInternal(
  orgId: string,
  userId: string,
  opts: { emailQuery?: string; folderId?: string },
  useAi: boolean,
): Promise<IngestResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'not_configured', emails: 0, documents: 0, replies: 0, tasks: 0 };

  let emailCount = 0;
  let docCount = 0;
  let replyCount = 0;
  let taskCount = 0;

  // ── Emails ────────────────────────────────────────────────
  const gmail = await gmailFor(userId);
  const selfEmail = gmail ? await getProfileEmail(gmail) : '';
  if (gmail) {
    const ids = await listMessageIds(gmail, opts.emailQuery ?? 'newer_than:3d -in:sent', 25);
    for (const id of ids) {
      try {
        const { data: existing } = await supabaseAdmin
          .from('emails')
          .select('id')
          .eq('org_id', orgId)
          .eq('gmail_id', id)
          .maybeSingle();
        if (existing) continue;

        const email = await getEmail(gmail, id);
        // Every one of these is a Claude call. With reading turned off the
        // message is still stored, just unclassified and unlinked.
        const extracted = useAi ? await classifyEmail(email, { orgId }) : null;
        const projectId = await resolveByName(orgId, 'projects', extracted?.project_hint ?? null);
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
            received_at: email.receivedAt,
            project_id: projectId,
            vendor_id: vendorId,
            class: extracted?.class ?? 'unclassified',
            extracted_json: extracted ?? null,
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
          }
        }
      } catch (err) {
        console.error('[ingest] email failed', id, (err as Error).message);
      }
    }
  }

  // ── Drive documents (PDF quotes / confirmations) ──────────
  const drive = useAi ? await driveFor(userId) : null;
  if (drive) {
    const files = await listPdfs(drive, { folderId: opts.folderId, max: 15 });
    for (const file of files) {
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
        const projectId = await resolveByName(orgId, 'projects', extracted?.project_hint ?? null);

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
      }
    }
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'ingest.run',
    entity: 'ingest',
    meta: { emails: emailCount, documents: docCount, replies: replyCount, tasks: taskCount },
  });

  return { ok: true, emails: emailCount, documents: docCount, replies: replyCount, tasks: taskCount };
}
