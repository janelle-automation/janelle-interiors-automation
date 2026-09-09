import { supabaseAdmin } from '../lib/supabase.js';
import { PROJECT_STAGES, type PoStatus, type ProjectStage } from '@janelle/shared';

/** Move a project forward to a signalled stage (never backwards). */
async function advanceStage(projectId: string | null, signal?: string | null): Promise<void> {
  if (!supabaseAdmin || !projectId || !signal) return;
  const next = signal as ProjectStage;
  if (!PROJECT_STAGES.includes(next)) return;
  const { data: proj } = await supabaseAdmin.from('projects').select('stage').eq('id', projectId).maybeSingle();
  if (!proj) return;
  if (PROJECT_STAGES.indexOf(next) > PROJECT_STAGES.indexOf((proj as { stage: ProjectStage }).stage)) {
    await supabaseAdmin.from('projects').update({ stage: next }).eq('id', projectId);
  }
}

/**
 * Promote parsed intelligence (documents + emails) into structured
 * records — vendors, projects, purchase orders — so the tracking
 * board and dashboard reflect real data. Idempotent: dedupes by name
 * and PO number, links documents/emails to what it creates.
 */

/** Lowercase, strip diacritics and filler words for fuzzy matching. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, "") // drop accents: Leon
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(project|the|for|re|fwd|quote|order|proposal|inc|llc|ltd|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two names refer to the same entity (exact-normalized or containment). */
function sameEntity(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 6 && long.includes(short);
}

async function upsertVendor(orgId: string, name?: string | null, email?: string | null): Promise<string | null> {
  if (!supabaseAdmin || !name || name.trim().length < 2) return null;
  const clean = name.trim();
  const norm = normalize(clean);
  if (norm.length < 2) return null;

  const { data: all } = await supabaseAdmin.from('vendors').select('id, name, contacts').eq('org_id', orgId);
  const hit = (all ?? []).find((v) => sameEntity(normalize((v as { name: string }).name), norm)) as
    | { id: string; contacts: { email?: string }[] | null }
    | undefined;

  if (hit) {
    if (email) {
      const contacts = Array.isArray(hit.contacts) ? hit.contacts : [];
      if (!contacts.some((c) => c.email === email)) {
        await supabaseAdmin.from('vendors').update({ contacts: [...contacts, { email }] }).eq('id', hit.id);
      }
    }
    return hit.id;
  }

  const contacts = email ? [{ email }] : [];
  const { data } = await supabaseAdmin
    .from('vendors')
    .insert({ org_id: orgId, name: clean, contacts })
    .select('id')
    .maybeSingle();
  return (data?.id as string) ?? null;
}

/**
 * Find-or-create a project by fuzzy name match (so "OVI Topa Courtyard"
 * and "Topa Courtyard" resolve to one), and fill in client / target
 * install where they are still blank.
 */
async function upsertProject(
  orgId: string,
  name?: string | null,
  opts: { client?: string | null; target?: string | null } = {},
): Promise<string | null> {
  if (!supabaseAdmin || !name || name.trim().length < 3) return null;
  const clean = name.trim();
  const norm = normalize(clean);
  if (norm.length < 3) return null;

  const { data: all } = await supabaseAdmin
    .from('projects')
    .select('id, name, client_name, target_install')
    .eq('org_id', orgId);

  const hit = (all ?? []).find((p) => sameEntity(normalize((p as { name: string }).name), norm)) as
    | { id: string; name: string; client_name: string | null; target_install: string | null }
    | undefined;

  if (hit) {
    const patch: Record<string, unknown> = {};
    if (opts.client && !hit.client_name) patch.client_name = opts.client;
    if (opts.target && !hit.target_install) patch.target_install = opts.target;
    // Prefer the shorter, cleaner project name if the new one is shorter.
    if (clean.length < hit.name.length && normalize(hit.name).includes(norm)) patch.name = clean;
    if (Object.keys(patch).length) await supabaseAdmin.from('projects').update(patch).eq('id', hit.id);
    return hit.id;
  }

  const { data } = await supabaseAdmin
    .from('projects')
    .insert({
      org_id: orgId,
      name: clean,
      stage: 'spec',
      status: 'active',
      client_name: opts.client ?? null,
      target_install: opts.target ?? null,
    })
    .select('id')
    .maybeSingle();
  return (data?.id as string) ?? null;
}

interface ParsedDoc {
  type?: string;
  vendor?: string | null;
  po_number?: string | null;
  project_hint?: string | null;
  client?: string | null;
  total?: number | null;
  order_date?: string | null;
  eta?: string | null;
  line_items?: { description?: string; sku?: string | null; qty?: number; unit_price?: number | null }[];
}

/** Create/link a vendor, project and PO from one parsed document. */
export async function promoteDocument(
  orgId: string,
  doc: { id: string; type: string; parsed_json: ParsedDoc | null; project_id: string | null },
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const p = doc.parsed_json;
  if (!p) return false;

  const isOrderish = ['quote', 'order_confirmation', 'purchase_order'].includes(doc.type);
  const total = Number(p.total ?? 0);
  // Only promote things that actually look like a quote/PO.
  if (!isOrderish || (!p.po_number && !(total > 0))) return false;

  const vendorId = await upsertVendor(orgId, p.vendor);
  const projectId = doc.project_id ?? (await upsertProject(orgId, p.project_hint, { client: p.client, target: p.eta }));

  // Dedupe by PO number when present, else by vendor + project + amount
  // (so the same quote arriving on several attachments makes one PO).
  let poId: string | null = null;
  if (p.po_number) {
    const { data } = await supabaseAdmin
      .from('purchase_orders')
      .select('id')
      .eq('org_id', orgId)
      .eq('po_number', p.po_number)
      .limit(1)
      .maybeSingle();
    poId = (data?.id as string) ?? null;
  } else if (vendorId && total > 0) {
    let q = supabaseAdmin
      .from('purchase_orders')
      .select('id')
      .eq('org_id', orgId)
      .eq('vendor_id', vendorId)
      .eq('amount', total);
    q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
    const { data } = await q.limit(1).maybeSingle();
    poId = (data?.id as string) ?? null;
  }

  if (!poId) {
    const status: PoStatus =
      doc.type === 'order_confirmation' ? 'confirmed' : doc.type === 'purchase_order' ? 'placed' : 'draft';
    const { data: po } = await supabaseAdmin
      .from('purchase_orders')
      .insert({
        org_id: orgId,
        po_number: p.po_number ?? null,
        vendor_id: vendorId,
        project_id: projectId,
        amount: total > 0 ? total : null,
        status,
        order_date: p.order_date ?? null,
        eta: p.eta ?? null,
      })
      .select('id')
      .maybeSingle();
    poId = (po?.id as string) ?? null;

    if (poId && Array.isArray(p.line_items)) {
      for (const li of p.line_items.slice(0, 50)) {
        await supabaseAdmin.from('line_items').insert({
          org_id: orgId,
          po_id: poId,
          description: li.description || 'Item',
          sku: li.sku ?? null,
          qty: Number(li.qty) || 1,
          unit_price: li.unit_price ?? null,
        });
      }
    }
  }

  await supabaseAdmin.from('documents').update({ project_id: projectId, po_id: poId }).eq('id', doc.id);

  // Advance the project stage based on what this document represents.
  const docStage =
    doc.type === 'order_confirmation' ? 'production' : doc.type === 'purchase_order' ? 'po' : doc.type === 'quote' ? 'spec' : null;
  await advanceStage(projectId, docStage);

  return Boolean(poId);
}

/** Create/link a vendor and project from one classified email. */
export async function promoteEmail(
  orgId: string,
  email: {
    id: string;
    class: string;
    vendor_id: string | null;
    project_id: string | null;
    extracted_json: {
      vendor_hint?: string | null;
      project_hint?: string | null;
      reply_to_email?: string | null;
      client_name?: string | null;
      target_date?: string | null;
      stage_signal?: string | null;
    } | null;
  },
): Promise<void> {
  if (!supabaseAdmin) return;
  const ex = email.extracted_json;
  if (!ex) return;
  if (email.class === 'general' || email.class === 'houzz_notification' || email.class === 'unclassified') return;

  const vendorId = email.vendor_id ?? (await upsertVendor(orgId, ex.vendor_hint, ex.reply_to_email));
  const projectId =
    email.project_id ?? (await upsertProject(orgId, ex.project_hint, { client: ex.client_name, target: ex.target_date }));
  if (vendorId !== email.vendor_id || projectId !== email.project_id) {
    await supabaseAdmin.from('emails').update({ vendor_id: vendorId, project_id: projectId }).eq('id', email.id);
  }

  // Advance the project's stage based on what this email signals.
  await advanceStage(projectId, ex.stage_signal);
}

/** Backfill: promote every existing document and email for an org. */
export async function promoteAll(orgId: string): Promise<{ pos: number; vendors: number; projects: number }> {
  if (!supabaseAdmin) return { pos: 0, vendors: 0, projects: 0 };

  const { data: docs } = await supabaseAdmin
    .from('documents')
    .select('id, type, parsed_json, project_id')
    .eq('org_id', orgId);
  for (const d of docs ?? []) {
    try {
      await promoteDocument(orgId, d as never);
    } catch (err) {
      console.error('[promote] document failed', (d as { id: string }).id, (err as Error).message);
    }
  }

  const { data: emails } = await supabaseAdmin
    .from('emails')
    .select('id, class, vendor_id, project_id, extracted_json')
    .eq('org_id', orgId);
  for (const e of emails ?? []) {
    try {
      await promoteEmail(orgId, e as never);
    } catch (err) {
      console.error('[promote] email failed', (e as { id: string }).id, (err as Error).message);
    }
  }

  const [{ count: pos }, { count: vendors }, { count: projects }] = await Promise.all([
    supabaseAdmin.from('purchase_orders').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
    supabaseAdmin.from('vendors').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
    supabaseAdmin.from('projects').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
  ]);

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'promote.run',
    entity: 'promote',
    meta: { pos: pos ?? 0, vendors: vendors ?? 0, projects: projects ?? 0 },
  });

  return { pos: pos ?? 0, vendors: vendors ?? 0, projects: projects ?? 0 };
}
