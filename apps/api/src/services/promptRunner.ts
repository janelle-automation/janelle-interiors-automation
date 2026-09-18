import type { SupabaseClient } from '@supabase/supabase-js';
import type { PromptVariable } from '@janelle/shared';
import { generate } from './anthropic.js';
import { isStudioMailbox, STUDIO_LETTERHEAD } from '../lib/studioTeam.js';

/**
 * Running one of the studio's library prompts.
 *
 * Lives apart from the route because Jenny runs them too. The Prompt Studio
 * and the assistant must produce the same work from the same prompt — if the
 * studio's moodboard prompt is the standard, it cannot quietly become a
 * different standard the moment someone asks for a moodboard in the chat.
 */

export const PROMPT_RUN_SYSTEM =
  'You are an assistant for an interior design studio. Write in a warm, precise, professional ' +
  'studio voice. Return only the requested content. ' +
  'Never write a bracketed placeholder such as [Studio Name], [Contact Name], [Phone] or [Email]. ' +
  'The studio, the sender, the project and the orders already on file are given to you under ' +
  'STUDIO RECORDS whenever they are known — use them. Where something is genuinely unknown, leave ' +
  'the line out or mark it TBD in plain words; never invent an order number, a price, a date, a SKU ' +
  'or a contact, and never contradict what the records say.';

export interface LibraryPrompt {
  id: string;
  title: string;
  template: string;
  variables: PromptVariable[] | null;
  /** Absent on older callers; only decides whether the letterhead is sent. */
  category?: string | null;
}

/** The library row a name refers to: an id, then an exact title, then a partial one. */
export function matchPrompt<T extends { id: string; title: string }>(rows: T[], wanted: string): T | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;
  return (
    rows.find((r) => r.id === wanted) ??
    rows.find((r) => r.title.toLowerCase() === needle) ??
    rows.find((r) => r.title.toLowerCase().includes(needle)) ??
    // Last resort, so "moodboard for the primary bath" still finds
    // "Primary bathroom moodboard": every word of the title present.
    rows.find((r) => r.title.toLowerCase().split(/\s+/).every((w) => needle.includes(w))) ??
    null
  );
}

/** The labels of the required inputs that were not supplied. */
export function missingInputs(vars: PromptVariable[] | null, values: Record<string, string>): string[] {
  return (vars ?? []).filter((v) => v.required && !values[v.key]?.trim()).map((v) => v.label);
}

/** `{{key}}` → the value, with anything unfilled left blank rather than printed. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? '');
}

// ────────────────────────────────────────────────────────────
//  What the studio's own records already know
//
//  The Studio's form is a handful of free-text boxes, so a purchase order
//  drafted from it came out addressed to nobody: no client, no order
//  number, and [Studio Name] where the signature belongs. All three are on
//  file — a project knows its client, a vendor knows its contact, and the
//  orders captured from Gmail and Drive know their PO numbers. Resolve the
//  typed names against those rows and hand Claude the facts, rather than
//  asking it to write around the blanks.
// ────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  client_name: string | null;
  stage: string;
  status: string;
  target_install: string | null;
}

interface VendorRow {
  id: string;
  name: string;
  category: string | null;
  contacts: { name?: string; email?: string; phone?: string }[] | null;
}

interface PoRow {
  po_number: string | null;
  status: string;
  amount: number | null;
  order_date: string | null;
  eta: string | null;
  vendors: { name: string } | null;
  projects: { name: string } | null;
  line_items: { description: string; sku: string | null; qty: number; unit_price: number | null }[] | null;
}

/** `%needle%`, with the characters PostgREST reads as filter syntax taken out. */
function like(s: string): string {
  return `%${s.replace(/[%_,().*]/g, ' ').trim()}%`;
}

const money = (n: number | null) => (n == null ? null : `$${Number(n).toLocaleString('en-US')}`);

/** The parts of a line that exist, joined — so a half-known fact still reads. */
const clause = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' — ');

/**
 * The project this run is about.
 *
 * An explicit pick from the dropdown is the answer. Otherwise the typed name
 * is matched against live projects — and "OVIS" is deliberately left
 * unresolved when it is both OVIS GOLF and OVIS Cabana, because guessing
 * which job an order belongs to is worse than saying it is unclear.
 */
async function findProjects(
  db: SupabaseClient,
  projectId: string | null | undefined,
  typed: string,
): Promise<ProjectRow[]> {
  const cols = 'id, name, client_name, stage, status, target_install';
  if (projectId) {
    const { data } = await db.from('projects').select(cols).eq('id', projectId).maybeSingle();
    if (data) return [data as ProjectRow];
  }
  const needle = typed.trim();
  if (needle.length < 2) return [];
  const { data } = await db
    .from('projects')
    .select(cols)
    .or(`name.ilike.${like(needle)},client_name.ilike.${like(needle)}`)
    .neq('status', 'archived')
    .limit(4);
  return (data ?? []) as ProjectRow[];
}

async function findVendors(db: SupabaseClient, typed: string): Promise<VendorRow[]> {
  const needle = typed.trim();
  if (needle.length < 2) return [];
  const { data } = await db
    .from('vendors')
    .select('id, name, category, contacts')
    .ilike('name', like(needle))
    .limit(4);
  return (data ?? []) as VendorRow[];
}

/** The orders already on file for this project and/or vendor, newest first. */
async function findOrders(
  db: SupabaseClient,
  project: ProjectRow | null,
  vendor: VendorRow | null,
): Promise<PoRow[]> {
  if (!project && !vendor) return [];
  let q = db
    .from('purchase_orders')
    .select(
      'po_number, status, amount, order_date, eta, vendors(name), projects(name), ' +
        'line_items(description, sku, qty, unit_price)',
    )
    .order('created_at', { ascending: false })
    .limit(6);
  if (project) q = q.eq('project_id', project.id);
  if (vendor) q = q.eq('vendor_id', vendor.id);
  const { data } = await q;
  return (data ?? []) as unknown as PoRow[];
}

function describeOrder(po: PoRow): string[] {
  const head = clause(
    po.po_number ? `PO ${po.po_number}` : 'Order (no PO number recorded)',
    po.vendors?.name,
    po.projects?.name,
    `status ${po.status}`,
    money(po.amount),
    po.order_date ? `ordered ${po.order_date}` : null,
    po.eta ? `ETA ${po.eta}` : null,
  );
  const lines = (po.line_items ?? [])
    .slice(0, 6)
    .map(
      (li) =>
        `      ${li.qty} x ${li.description}` +
        (li.sku ? ` (SKU ${li.sku})` : '') +
        (li.unit_price != null ? ` @ ${money(li.unit_price)}` : ''),
    );
  return [`  - ${head}`, ...lines];
}

/**
 * The STUDIO RECORDS block, or '' when nothing is known.
 *
 * Never throws: a prompt that produced work yesterday must not start failing
 * because a lookup did.
 */
export async function studioRecords(
  db: SupabaseClient,
  values: Record<string, string>,
  ctx: { userId: string; projectId?: string | null; category?: string | null },
): Promise<string> {
  try {
    const facts: string[] = [];
    // A moodboard is not written on the studio's letterhead, and the address
    // and phone number would only be noise in it.
    const onPaper = ctx.category === 'procurement' || ctx.category === 'client';

    const [orgRes, meRes] = await Promise.all([
      db.from('organizations').select('name').limit(1).maybeSingle(),
      db.from('profiles').select('full_name, email').eq('id', ctx.userId).maybeSingle(),
    ]);
    const org = orgRes.data as { name: string } | null;
    const me = meRes.data as { full_name: string | null; email: string | null } | null;

    const paper = STUDIO_LETTERHEAD;
    facts.push(`Studio: ${org?.name ?? paper.name}`);
    if (onPaper) {
      facts.push(
        `Studio address: ${paper.address.join(', ')}`,
        `Studio phone: ${paper.phone} — website ${paper.website}`,
        `Correspondence address for vendors: ${paper.correspondence}`,
        `Signs off as: ${paper.signOff}`,
      );
    }
    // The connected account is a shared inbox, not a person: signing an order
    // "systems@" told the vendor nothing and told them to write to a mailbox
    // that is not the one the studio watches for correspondence.
    const senderEmail = me?.email && !isStudioMailbox(me.email) ? me.email : null;
    if (me?.full_name || senderEmail) facts.push(`Raised by: ${clause(me?.full_name, senderEmail)}`);
    facts.push(`Today: ${new Date().toISOString().slice(0, 10)}`);

    const projects = await findProjects(db, ctx.projectId, values.project ?? '');
    let project: ProjectRow | null = null;
    if (projects.length === 1) {
      project = projects[0];
      facts.push(
        '',
        clause(
          `Project: ${project.name}`,
          project.client_name ? `client ${project.client_name}` : 'client not recorded — CONFIRM CLIENT',
          `stage ${project.stage}`,
          project.target_install ? `target install ${project.target_install}` : null,
        ),
      );
    } else if (projects.length > 1) {
      facts.push(
        '',
        `Project: "${(values.project ?? '').trim()}" matches more than one live project — ` +
          projects.map((p) => `${p.name}${p.client_name ? ` (${p.client_name})` : ''}`).join(', ') +
          '. Do not pick one: name the candidates and mark the project and client ' +
          'TBD — CONFIRM WHICH PROJECT.',
      );
    }

    const vendors = await findVendors(db, values.vendor ?? '');
    let vendor: VendorRow | null = null;
    if (vendors.length === 1) {
      vendor = vendors[0];
      const contact = (vendor.contacts ?? [])[0];
      facts.push('', clause(`Vendor: ${vendor.name}`, vendor.category, contact?.name, contact?.email, contact?.phone));
    } else if (vendors.length > 1) {
      facts.push(
        '',
        `Vendor: "${(values.vendor ?? '').trim()}" matches ${vendors.map((v) => v.name).join(', ')} — confirm which.`,
      );
    }

    const orders = await findOrders(db, project, vendor);
    if (orders.length) {
      facts.push('', 'Purchase orders already on file (captured from Gmail and Drive):');
      for (const po of orders) facts.push(...describeOrder(po));
      facts.push(
        orders.some((p) => p.po_number)
          ? '  These are real order numbers. Reference one only when this run is about that order; a new ' +
            'order is numbered by the studio, so write PO NUMBER TBD rather than continuing the sequence yourself.'
          : '  None of these orders has a PO number recorded, so there is no number to quote. Write ' +
            'PO NUMBER TBD — ASSIGN BEFORE SENDING and say so; do not invent one.',
      );
    } else if (project || vendor) {
      facts.push('', 'No purchase orders are on file for this project and vendor yet.');
    }

    // The date on its own is not worth the tokens.
    if (facts.length <= 1) return '';

    return [
      '',
      '',
      "STUDIO RECORDS — from the studio's own database. Use these facts, do not contradict them,",
      'and do not invent anything that is not here.',
      '',
      ...facts,
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * Run a prompt and record it. The run is logged wherever it was started
 * from, so `prompt_runs` stays the honest history of what the studio has
 * asked Claude to write.
 */
export async function runLibraryPrompt(
  db: SupabaseClient,
  prompt: LibraryPrompt,
  values: Record<string, string>,
  ctx: { orgId: string | null; userId: string; projectId?: string | null },
): Promise<string> {
  const records = await studioRecords(db, values, { ...ctx, category: prompt.category ?? null });
  const output = await generate(PROMPT_RUN_SYSTEM, fillTemplate(prompt.template, values) + records, {
    feature: 'prompt.run',
    orgId: ctx.orgId,
    actor: ctx.userId,
    entity: 'prompts',
    entityId: prompt.id,
  });

  await db.from('prompt_runs').insert({
    org_id: ctx.orgId,
    prompt_id: prompt.id,
    project_id: ctx.projectId ?? null,
    user_id: ctx.userId,
    input: values,
    output,
  });

  return output;
}
