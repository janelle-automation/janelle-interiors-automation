import { supabaseAdmin } from '../lib/supabase.js';
import { forgetStudioNames } from '../lib/studioNames.js';
import {
  isAutomatedAddress, isSoftwareService, isStudioAddress, isStudioName, orderedByTeammate,
} from '../lib/studioTeam.js';
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
    .replace(/[̀-ͯ]/g, '') // drop accents: Leon
    .toLowerCase()
    // Possessive: "Lemon's" is the Lemon job — and mail clients send the
    // curly apostrophe as often as the straight one.
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(project|the|for|re|fwd|quote|order|proposal|inc|llc|ltd|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that place a job rather than name it, plus the scaffolding around
 * an address. "Lemon Residence 291 Saddle Lane Ojai, CA 93023" and "Lemon"
 * are the same job written long and short.
 */
const NOISE_WORDS = new Set([
  'residence', 'residences', 'house', 'home', 'property', 'job', 'site', 'apt', 'apartment',
  'lane', 'street', 'st', 'road', 'rd', 'ave', 'avenue', 'drive', 'blvd', 'boulevard',
  'way', 'court', 'ct', 'place', 'pl', 'terrace', 'circle', 'unit', 'ste',
  'ca', 'usa', 'us',
  // Paperwork, not a place. "Schumacher Hospitality PO" is the purchase
  // order for that supplier, which is why it ended up filed as a project
  // as well as a vendor — the "PO" was the only thing telling them apart.
  'po', 'pos', 'rfq', 'rfi', 'invoice', 'estimate', 'proposal', 'confirmation',
]);

/**
 * The words that actually identify a job.
 *
 * Numbers are dropped outright: "Lemon 81326" and "Carissa 90826/Oak Kit"
 * carry a Houzz job number, and a street number and postcode ride along in
 * an address — none of them tell one project from another, while all of
 * them stopped the names matching. Plurals fold in for the same reason,
 * so "Lemons" and "Lemon" are one job.
 */
function keyWords(normalized: string): string[] {
  return normalized
    .split(' ')
    .filter(Boolean)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !NOISE_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * One name's word is the other's, allowing for an abbreviation:
 * "Oak Kit" is the Oak Kitchen, but "Ojai" is not "Oj".
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Words that name nothing in particular. `normalize` already drops a few;
 * these are the ones Claude reaches for when an email has no project name
 * in it at all, and every one of them used to become a project row.
 */
const GENERIC_WORDS = new Set([
  'client', 'clients', 'customer', 'enquiry', 'inquiry', 'invoice', 'sample', 'samples',
  'update', 'updates', 'meeting', 'delivery', 'shipping', 'install', 'installation',
  'general', 'unknown', 'none', 'null', 'na', 'various', 'misc', 'miscellaneous',
  'tbc', 'tba', 'unspecified', 'new', 'job', 'work', 'design', 'interior', 'interiors',
  'residence', 'house', 'home', 'apartment', 'hotel', 'office', 'room', 'kitchen',
  'bathroom', 'bedroom', 'living', 'lobby', 'suite', 'unit', 'site', 'build',
]);

/** Word tokens of an already-normalized name. */
function words(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

/**
 * Two names refer to the same entity.
 *
 * Substring containment missed the commonest duplicate — a hint that is
 * part of the real name ("Topa" arriving against "Topa Courtyard") — because
 * the shorter side had to be six characters, so both were stored. Compare
 * identifying words instead: every word of the shorter name present in the
 * longer one is the same job, which folds "Lemon", "Lemons", "Lemon's" and
 * "Lemon Residence 291 Saddle Lane" together once the plural, the job
 * number and the address have been set aside. It still keeps "Miller House"
 * and "Miller Barn" apart, and "OVI Oak Kitchen" apart from "OVI
 * Oak/Ballrooms" — a kitchen and a ballroom are not the same room, and only
 * the studio knows whether they are the same job.
 *
 * Vendors match the same way, which is why the generic-word test lives in
 * `namesAProject` and not here — "The Kitchen Co" is a perfectly good
 * vendor, and it normalizes down to one generic word.
 */
function sameEntity(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = keyWords(a);
  const kb = keyWords(b);
  if (!ka.length || !kb.length) return false;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  // A single word carries the whole claim, so it has to be worth something.
  if (short.length === 1 && short[0].length < 4) return false;
  return short.every((w) => long.some((l) => sameWord(w, l)));
}

/**
 * The existing project a name refers to, or null.
 *
 * Exported so the Houzz import lands on the project an email already
 * raised — "Lemons" in the system and "Lemon Residence" in the export are
 * one job, and matching them here is what stops the import from doubling
 * the list it was meant to straighten out.
 */
export function matchProjectId(projects: { id: string; name: string }[], name: string): string | null {
  return bestEntityMatch(projects, name)?.id ?? null;
}

/**
 * The one row a name means: the row named exactly that, else the closest of
 * the rows it loosely matches — never a pick between two equally close ones.
 *
 * "The first loose match" filed "OVIS Cabana" mail under "OVIS Spa Cabana"
 * whenever that row happened to come first: every word of the shorter name
 * is in the longer one. Two real projects can share words; the closer name,
 * the one with fewer words left over, is the one meant.
 */
function bestEntityMatch<T extends { id: string; name: string }>(rows: T[], name: string): T | null {
  const norm = normalize(name);
  if (!norm) return null;
  const exact = rows.filter((r) => normalize(r.name) === norm);
  if (exact.length === 1) return exact[0];
  const loose = rows.filter((r) => sameEntity(normalize(r.name), norm));
  if (loose.length <= 1) return loose[0] ?? null;
  const said = keyWords(norm);
  const extra = (r: T) => {
    const theirs = keyWords(normalize(r.name));
    return theirs.filter((w) => !said.some((s) => sameWord(s, w))).length + said.filter((s) => !theirs.some((w) => sameWord(s, w))).length;
  };
  const scored = loose.map((r) => ({ r, d: extra(r) })).sort((a, b) => a.d - b.d);
  return scored[0].d < scored[1].d ? scored[0].r : null;
}

/**
 * The one project a client belongs to, or null.
 *
 * An email often names the client and never the job — "Sarah Lemon approved
 * the banquette". When exactly one project is for that client, that is the
 * job; when there are two, it is not safe to pick.
 */
export function matchClientProjectId(
  projects: { id: string; client_name: string | null }[],
  client: string,
): string | null {
  const norm = normalize(client);
  if (!norm) return null;
  // The studio is on every job's paperwork; it identifies none of them. A
  // project wrongly recorded with the studio as its client drew in every
  // document that named the studio — an Ojai Valley Inn quote was filed
  // under the Lemon job that way.
  if (isStudioName(client)) return null;
  const hits = projects.filter(
    (p) => p.client_name && !isStudioName(p.client_name) && sameEntity(normalize(p.client_name), norm),
  );
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * A project name as the studio would file it.
 *
 * The model is asked for a clean name, but this is where a row is actually
 * written, so the commonest slips are removed here whatever came in:
 * "Lemon's Project" is the Lemon job, and "the lemon project" is too.
 */
export function cleanProjectName(raw: string): string {
  let s = orderedByTeammate(raw)
    .trim()
    .replace(/['’]s\b/gi, '')
    .replace(/\b(project|job)\b/gi, ' ')
    .replace(/^\s*the\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,.#]+|[\s\-–—:,.#]+$/g, '')
    .trim();
  // Typed all in lower case, a name reads as a slip; give each word its capital.
  if (s && s === s.toLowerCase()) s = s.replace(/(^|\s)(\p{L})/gu, (_m, space: string, c: string) => space + c.toUpperCase());
  return s;
}

/** Words that say what a property is — the mark of a name the studio chose. */
const PROPERTY_WORDS =
  /\b(residence|house|home|hotel|suite|apartment|loft|villa|estate|condo|cottage|inn|resort|office|restaurant|showroom|penthouse|ranch|lodge|studio)\b/i;

/**
 * How good a project name is, for choosing between two that mean one job.
 *
 * Replaces "prefer the shorter name", which renamed "Lemon Residence" to
 * "Lemon's" the first time an email said it that way — shorter, and worse.
 * A name wins by being a proper name: no possessive, no "project", saying
 * what the property is, and not a street address or a job number.
 */
export function nameQuality(name: string): number {
  let q = 0;
  if (/['’]s\b/i.test(name)) q -= 3;
  if (/\bproject\b/i.test(name)) q -= 2;
  if (name === name.toLowerCase()) q -= 1;
  if (PROPERTY_WORDS.test(name)) q += 2;
  if (keyWords(normalize(name)).length >= 2) q += 1;
  if (/\d{4,}/.test(name)) q -= 1;
  if (/\b\d+\s+\w+\s+(lane|ln|street|st|road|rd|avenue|ave|drive|dr|boulevard|blvd|way|court|ct)\b/i.test(name)) q -= 2;
  if (/\b[A-Z]{2}\s+\d{5}\b/.test(name)) q -= 1;
  if (name.length > 60) q -= 2;
  // "Carissa 90826/Oak Kit": who placed the order and when, not the job.
  if (orderedByTeammate(name) !== name || isStudioName(name)) q -= 3;
  return q;
}

/**
 * Whether a hint is specific enough to be treated as a project at all.
 *
 * `project_hint` is Claude's best guess, and its best guess for mail that
 * concerns no project is the subject's topic — or the vendor, which already
 * has a row of its own. Both left a project behind per email.
 */
export function namesAProject(hint?: string | null, vendorHint?: string | null): boolean {
  const norm = normalize(hint ?? '');
  if (norm.length < 4) return false;
  if (isSoftwareService(hint) || isStudioName(hint)) return false;
  if (words(norm).every((w) => GENERIC_WORDS.has(w))) return false;
  if (vendorHint && sameEntity(norm, normalize(vendorHint))) return false;
  return true;
}

/**
 * Below this, Claude is guessing at the project rather than reading it.
 * Such an email may still be filed against a project that exists, but it
 * may not open a new one.
 */
const MIN_PROJECT_CONFIDENCE = 0.55;

/** A vendor's person. Only ever the vendor's own — never the client's, never the studio's. */
export interface VendorContact {
  name?: string | null;
  email?: string | null;
}

async function upsertVendor(orgId: string, name?: string | null, contact: VendorContact = {}): Promise<string | null> {
  if (!supabaseAdmin || !name || name.trim().length < 2) return null;
  // The studio and its people are never a vendor, nor is the software the
  // studio runs on — Slack and GitHub write a lot of email.
  if (isStudioName(name) || isSoftwareService(name)) return null;
  const email = contact.email?.trim().toLowerCase() || null;
  // A studio address is never a vendor's contact — the reply goes to the
  // vendor, not to Brianna — and neither is a no-reply sender.
  const usable = email && email.includes('@') && !isStudioAddress(email) && !isAutomatedAddress(email) ? email : null;
  const person = contact.name?.trim() || null;
  const clean = name.trim();
  const norm = normalize(clean);
  if (norm.length < 2) return null;

  const { data: all } = await supabaseAdmin.from('vendors').select('id, name, contacts').eq('org_id', orgId);
  const hit = (all ?? []).find((v) => sameEntity(normalize((v as { name: string }).name), norm)) as
    | { id: string; contacts: { email?: string; name?: string }[] | null }
    | undefined;

  if (hit) {
    if (usable) {
      const contacts = Array.isArray(hit.contacts) ? hit.contacts : [];
      if (!contacts.some((c) => c.email?.toLowerCase() === usable)) {
        await supabaseAdmin
          .from('vendors')
          .update({ contacts: [...contacts, { email: usable, ...(person ? { name: person } : {}) }] })
          .eq('id', hit.id);
      }
    }
    return hit.id;
  }

  const contacts = usable ? [{ email: usable, ...(person ? { name: person } : {}) }] : [];
  forgetStudioNames(orgId);
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
 *
 * With `create: false` this only ever finds: the caller had a name but not
 * enough confidence in it to open a project the studio never asked for.
 */
async function upsertProject(
  orgId: string,
  name?: string | null,
  opts: { client?: string | null; target?: string | null; create?: boolean; betterName?: string | null } = {},
): Promise<string | null> {
  if (!supabaseAdmin || !name || name.trim().length < 3) return null;
  const clean = cleanProjectName(name);
  const norm = normalize(clean);
  if (norm.length < 3) return null;
  // A teammate is never the job, and never whom the job is for.
  if (isStudioName(clean) || isSoftwareService(clean)) return null;
  if (isStudioName(opts.client) || isSoftwareService(opts.client)) opts = { ...opts, client: null };

  const { data: all } = await supabaseAdmin
    .from('projects')
    .select('id, name, client_name, target_install')
    .eq('org_id', orgId);

  const hit = bestEntityMatch((all ?? []) as { id: string; name: string }[], clean) as
    | { id: string; name: string; client_name: string | null; target_install: string | null }
    | undefined;

  if (hit) {
    await improveProject(orgId, hit, { name: clean, betterName: opts.betterName, client: opts.client, target: opts.target });
    return hit.id;
  }

  if (opts.create === false) return null;
  forgetStudioNames(orgId);

  const { data } = await supabaseAdmin
    .from('projects')
    .insert({
      org_id: orgId,
      name: bestName([clean, opts.betterName]) ?? clean,
      stage: 'spec',
      status: 'active',
      client_name: opts.client ?? null,
      target_install: opts.target ?? null,
    })
    .select('id')
    .maybeSingle();
  return (data?.id as string) ?? null;
}

/** The best of some names for one job, or null when none is usable. */
function bestName(candidates: (string | null | undefined)[]): string | null {
  const names = candidates
    .filter((n): n is string => typeof n === 'string' && n.trim().length >= 3)
    .map(cleanProjectName)
    .filter((n) => n.length >= 3 && !isStudioName(n) && !isSoftwareService(n));
  if (!names.length) return null;
  return names.reduce((best, n) => (nameQuality(n) > nameQuality(best) ? n : best));
}

/**
 * Put right what a project was first recorded with, as better evidence arrives.
 *
 * A name is only ever replaced by a better one — "Lemon's" by "Lemon
 * Residence", never the reverse. A client is filled when missing, and
 * replaced when what was recorded is the studio itself: "Janelle Interiors"
 * as the client of the Lemon job was both wrong and, worse, drew every
 * document naming the studio into that project.
 */
async function improveProject(
  orgId: string,
  project: { id: string; name: string; client_name: string | null; target_install?: string | null },
  evidence: { name?: string | null; betterName?: string | null; client?: string | null; target?: string | null },
): Promise<void> {
  if (!supabaseAdmin) return;
  const patch: Record<string, unknown> = {};
  const candidate = bestName([evidence.name, evidence.betterName]);
  if (candidate && nameQuality(candidate) > nameQuality(project.name)) patch.name = candidate;
  const client = evidence.client?.trim();
  if (client && !isStudioName(client) && !isSoftwareService(client)) {
    if (!project.client_name || isStudioName(project.client_name)) patch.client_name = client;
  }
  if (evidence.target && !project.target_install) patch.target_install = evidence.target;
  if (!Object.keys(patch).length) return;
  await supabaseAdmin.from('projects').update(patch).eq('id', project.id).eq('org_id', orgId);
  forgetStudioNames(orgId);
}

/** improveProject for a project known by id. */
async function improveProjectById(
  orgId: string,
  projectId: string,
  evidence: { betterName?: string | null; client?: string | null; target?: string | null },
): Promise<void> {
  if (!supabaseAdmin) return;
  const { data } = await supabaseAdmin
    .from('projects')
    .select('id, name, client_name, target_install')
    .eq('id', projectId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (data) await improveProject(orgId, data as { id: string; name: string; client_name: string | null; target_install: string | null }, evidence);
}

interface ParsedDoc {
  type?: string;
  vendor?: string | null;
  better_project_name?: string | null;
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
  // A quote or PO is a strong enough signal to open a project, but only if
  // it actually names one — not when the hint is the vendor or "Samples".
  const hint = namesAProject(p.project_hint, p.vendor) ? p.project_hint : null;
  if (doc.project_id) await improveProjectById(orgId, doc.project_id, { betterName: p.better_project_name, client: p.client });
  const projectId =
    doc.project_id ?? (await upsertProject(orgId, hint, { client: p.client, target: p.eta, betterName: p.better_project_name }));

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
      vendor_contact_name?: string | null;
      vendor_contact_email?: string | null;
      project_hint?: string | null;
      project_is_existing?: boolean | null;
      better_project_name?: string | null;
      client_name?: string | null;
      target_date?: string | null;
      stage_signal?: string | null;
      confidence?: number | null;
    } | null;
  },
): Promise<void> {
  if (!supabaseAdmin) return;
  const ex = email.extracted_json;
  if (!ex) return;
  // Houzz's own notices are filed to a project that exists (by ingest) and
  // raise nothing; an unreadable email promotes nothing.
  if (email.class === 'houzz_notification' || email.class === 'unclassified') return;

  const orderish = email.class === 'vendor_quote' || email.class === 'order_confirmation';
  const confidence = ex.confidence ?? 1;

  // Most of the studio's mail about suppliers is not a quote: "can you chase
  // Workshop for the ottoman drawings". It used to be skipped outright, so
  // the vendor was never recorded and the task never linked to one. A
  // supplier is recorded from it when the email shows the supplier's own
  // address — the mark of a real counterparty, which a notification from
  // Slack or a passing mention does not have. The contact is the vendor's own
  // person, never the reply-to: that was often the client, which is how a
  // hotel's address ended up as House of Leon's contact.
  const contact = { name: ex.vendor_contact_name, email: ex.vendor_contact_email };
  const knownSupplier = orderish || Boolean(contact.email && !isAutomatedAddress(contact.email));
  const vendorId =
    email.vendor_id ?? (knownSupplier && confidence >= MIN_PROJECT_CONFIDENCE ? await upsertVendor(orgId, ex.vendor_hint, contact) : null);
  if (email.vendor_id && contact.email) await upsertVendor(orgId, ex.vendor_hint, contact);

  // Mail that names no project gets no project. Mail that names one but is
  // only guessing may be filed against a project that exists, but may not
  // open a new one — that is where the duplicates came from, one row per
  // email for correspondence that was never about a job in the first place.
  //
  // General mail opens a project only when it is plainly a new client job: the
  // model is sure, says the job is not one on the list, names who it is for,
  // and the name is a proper one ("Casa Elar Primary Suite", not "Hardware").
  const hint = namesAProject(ex.project_hint, ex.vendor_hint) ? ex.project_hint : null;
  const clientOk = Boolean(ex.client_name && !isStudioName(ex.client_name) && !isSoftwareService(ex.client_name));
  const properJob =
    ex.project_is_existing === false && confidence >= 0.7 && clientOk && nameQuality(cleanProjectName(hint ?? '')) >= 1;
  if (email.project_id) {
    await improveProjectById(orgId, email.project_id, { betterName: ex.better_project_name, client: ex.client_name, target: ex.target_date });
  }
  const projectId =
    email.project_id ??
    (await upsertProject(orgId, hint, {
      client: ex.client_name,
      target: ex.target_date,
      betterName: ex.better_project_name,
      create: orderish ? confidence >= MIN_PROJECT_CONFIDENCE : properJob,
    }));
  if (vendorId !== email.vendor_id || projectId !== email.project_id) {
    await supabaseAdmin.from('emails').update({ vendor_id: vendorId, project_id: projectId }).eq('id', email.id);
  }

  // Advance the project's stage based on what this email signals.
  await advanceStage(projectId, ex.stage_signal);
}

// ── Deduplication ───────────────────────────────────────────

/** Every table that points at a project and must follow it to the survivor. */
const PROJECT_REFS = [
  'emails',
  'documents',
  'purchase_orders',
  'tasks',
  'follow_ups',
  'spec_gaps',
  'prompt_runs',
] as const;

interface ProjectRow {
  id: string;
  name: string;
  client_name: string | null;
  target_install: string | null;
  stage: ProjectStage;
  status: string;
  budget: number | null;
  start_date: string | null;
  notes: string | null;
  houzz_ref: string | null;
  assigned_to: string | null;
  created_at: string | null;
}

/** Fields worth keeping, in the order a survivor is judged on. */
const FILLED_FIELDS = ['client_name', 'target_install', 'budget', 'start_date', 'notes', 'assigned_to'] as const;

function filledCount(p: ProjectRow): number {
  return FILLED_FIELDS.filter((f) => p[f] !== null && p[f] !== undefined && p[f] !== '').length;
}

/**
 * Which row of a duplicate group to suggest keeping.
 *
 * A row imported from Houzz Pro is the studio's own record and always wins.
 * Otherwise the most complete row does, and the oldest breaks a tie — it is
 * the one people have been looking at and linking to. Only a suggestion:
 * the caller names the survivor it actually wants.
 */
function pickSurvivor(group: ProjectRow[]): ProjectRow {
  return [...group].sort((a, b) => {
    if (Boolean(a.houzz_ref) !== Boolean(b.houzz_ref)) return a.houzz_ref ? -1 : 1;
    // A proper name is worth keeping over a filled field: "Carissa 90826/Oak
    // Kit" survived a merge over "OVI Oak Kitchen" by being older.
    const named = nameQuality(b.name) - nameQuality(a.name);
    if (named !== 0) return named;
    const filled = filledCount(b) - filledCount(a);
    if (filled !== 0) return filled;
    return (a.created_at ?? '').localeCompare(b.created_at ?? '');
  })[0];
}

export interface DuplicateCandidate {
  id: string;
  name: string;
  client_name: string | null;
  stage: ProjectStage;
  created_at: string | null;
  /** Mail, documents, POs and tasks filed against this row. */
  links: number;
}

export interface DuplicateGroup {
  /** The row suggested as the survivor; the caller may choose another. */
  suggestedKeepId: string;
  projects: DuplicateCandidate[];
  /**
   * How sure the names are. "likely" means every identifying word lines up
   * and the rows are offered ticked; "possible" means they only share one,
   * so they are offered for a look with nothing ticked.
   */
  confidence: 'likely' | 'possible';
}

async function projectRows(orgId: string): Promise<ProjectRow[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from('projects')
    .select('id, name, client_name, target_install, stage, status, budget, start_date, notes, houzz_ref, assigned_to, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as ProjectRow[];
}

/** How much is filed against each project, so a person can judge a merge. */
async function linkCounts(orgId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!supabaseAdmin) return counts;
  for (const table of ['emails', 'documents', 'purchase_orders', 'tasks'] as const) {
    const { data } = await supabaseAdmin.from(table).select('project_id').eq('org_id', orgId);
    for (const row of data ?? []) {
      const id = (row as { project_id: string | null }).project_id;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Projects that look like the same job written more than once.
 *
 * Only suggested, never merged here — merging deletes rows, and the names
 * alone cannot settle every case. "Lemons" and "Lemon 81326" are plainly
 * one job; "OVI Oak Kitchen" and "OVI Oak/Ballrooms" might be one job or
 * two rooms of it, and only the studio knows which.
 */
export async function findDuplicateProjects(orgId: string): Promise<{ groups: DuplicateGroup[] }> {
  const projects = await projectRows(orgId);
  const counts = await linkCounts(orgId);

  const candidate = (p: ProjectRow): DuplicateCandidate => ({
    id: p.id,
    name: p.name,
    client_name: p.client_name,
    stage: p.stage,
    created_at: p.created_at,
    links: counts.get(p.id) ?? 0,
  });

  // Two rows that both came from a Houzz Pro import are two projects the
  // studio itself keeps apart, whatever their names look like here.
  const oneImportOnly = (g: ProjectRow[]) =>
    new Set(g.map((p) => p.houzz_ref).filter(Boolean)).size <= 1;

  const toGroup = (g: ProjectRow[], confidence: 'likely' | 'possible'): DuplicateGroup => ({
    suggestedKeepId: pickSurvivor(g).id,
    projects: g.map(candidate),
    confidence,
  });

  // ── Likely: every identifying word lines up ───────────────
  // A project joins a group only when it matches EVERY name already in it.
  // Matching any one of them would let a short name bridge two jobs that
  // have nothing to do with each other — "Smith" pulls in both "Smith
  // Residence" and "Smith Barn", and a merge is a delete.
  const clusters: ProjectRow[][] = [];
  for (const p of projects) {
    const norm = normalize(p.name);
    const cluster = clusters.find((g) => g.every((m) => sameEntity(normalize(m.name), norm)));
    if (cluster) cluster.push(p);
    else clusters.push([p]);
  }

  const likely = clusters.filter((g) => g.length > 1).filter(oneImportOnly);
  const spokenFor = new Set(likely.flat().map((p) => p.id));

  // ── Possible: one identifying word in common ──────────────
  // "OVI Oak Kitchen", "OVI Oak/Ballrooms" and "Carissa 90826/Oak Kit" are
  // one job, but nothing in the names says so — a kitchen and a ballroom
  // read as two rooms. Grouping on a single shared word finds them without
  // pretending to be sure, so they are offered for a look, never ticked.
  const byWord = new Map<string, ProjectRow[]>();
  for (const p of projects) {
    if (spokenFor.has(p.id)) continue;
    for (const w of new Set(keyWords(normalize(p.name)))) {
      if (w.length < 3 || GENERIC_WORDS.has(w)) continue;
      byWord.set(w, [...(byWord.get(w) ?? []), p]);
    }
  }

  const possible: ProjectRow[][] = [];
  const seen = new Set<string>();
  const byWordGroups = [...byWord.entries()]
    // Biggest group first, so the word that gathers the whole family wins:
    // "oak" holds all three OVI rows where "ovi" holds only two, and
    // whichever claims them first is the one that is offered. A longer
    // shared word breaks a tie, being the more distinctive of the two.
    .sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length);

  for (const [, group] of byWordGroups) {
    // A word shared by half the studio is a house style, not a job name.
    if (group.length < 2 || group.length > 4) continue;
    if (group.some((p) => seen.has(p.id))) continue;
    if (!oneImportOnly(group)) continue;
    possible.push(group);
    for (const p of group) seen.add(p.id);
  }

  return {
    groups: [
      ...likely.map((g) => toGroup(g, 'likely')),
      ...possible.map((g) => toGroup(g, 'possible')),
    ],
  };
}

export interface MergeResult {
  ok: boolean;
  reason?: string;
  /** The surviving project's name. */
  kept?: string;
  /** How many rows were folded into it. */
  removed: number;
  /** How many linked records moved across. */
  moved: number;
}

/**
 * Fold the named projects into one, then delete them.
 *
 * Every reference is repointed at the survivor first, so nothing is lost —
 * `spec_gaps` and `follow_ups` cascade on delete and would otherwise go
 * with the row. The survivor takes any field it was missing and the
 * furthest stage the group reached, since the duplicate may be the row that
 * got advanced. Ids are checked against the org, so a caller cannot merge
 * another studio's projects.
 */
export async function mergeProjects(
  orgId: string,
  keepId: string,
  mergeIds: string[],
): Promise<MergeResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', removed: 0, moved: 0 };

  const losers = [...new Set(mergeIds)].filter((id) => id !== keepId);
  if (!losers.length) return { ok: false, reason: 'nothing_to_merge', removed: 0, moved: 0 };

  const projects = await projectRows(orgId);
  const keep = projects.find((p) => p.id === keepId);
  if (!keep) return { ok: false, reason: 'unknown_project', removed: 0, moved: 0 };

  const group = projects.filter((p) => losers.includes(p.id));
  if (group.length !== losers.length) return { ok: false, reason: 'unknown_project', removed: 0, moved: 0 };

  let moved = 0;
  for (const loser of group) {
    for (const table of PROJECT_REFS) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .update({ project_id: keep.id })
        .eq('org_id', orgId)
        .eq('project_id', loser.id)
        .select('id');
      if (error) return { ok: false, reason: `${table}: ${error.message}`, removed: 0, moved };
      moved += (data ?? []).length;
    }
  }

  const patch: Record<string, unknown> = {};
  for (const field of FILLED_FIELDS) {
    if (keep[field] === null || keep[field] === undefined || keep[field] === '') {
      const donor = group.find((l) => l[field] !== null && l[field] !== undefined && l[field] !== '');
      if (donor) patch[field] = donor[field];
    }
  }
  // Whichever row is kept, the job keeps its best name — unless the kept row
  // came from Houzz, whose name is the studio's own.
  if (!keep.houzz_ref) {
    const best = bestName([keep.name, ...group.map((l) => l.name)]);
    if (best && nameQuality(best) > nameQuality(keep.name)) patch.name = best;
  }
  // The same for the client: never the studio, when a loser knew better.
  if (isStudioName(keep.client_name)) {
    const donor = group.find((l) => l.client_name && !isStudioName(l.client_name));
    if (donor) patch.client_name = donor.client_name;
  }
  const furthest = [keep, ...group].reduce((a, b) =>
    PROJECT_STAGES.indexOf(b.stage) > PROJECT_STAGES.indexOf(a.stage) ? b : a,
  );
  if (furthest.stage !== keep.stage) patch.stage = furthest.stage;
  if (Object.keys(patch).length) {
    await supabaseAdmin.from('projects').update(patch).eq('id', keep.id);
  }

  const { error: delError } = await supabaseAdmin
    .from('projects')
    .delete()
    .eq('org_id', orgId)
    .in(
      'id',
      group.map((l) => l.id),
    );
  if (delError) return { ok: false, reason: delError.message, removed: 0, moved };

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'projects.merged',
    entity: 'project',
    entity_id: keep.id,
    meta: { kept: keep.name, removed: group.map((l) => l.name), moved },
  });

  return { ok: true, kept: keep.name, removed: group.length, moved };
}

export interface AutoMergeResult {
  ok: boolean;
  reason?: string;
  /** One entry per group folded together. */
  merged: { kept: string; removed: string[] }[];
  /** Project rows deleted. */
  removed: number;
  /** Linked records moved to a survivor. */
  moved: number;
}

/**
 * Fold every duplicate group into one project, without asking.
 *
 * Runs itself at the end of a reading pass, so the studio never has to
 * tidy up after the mail. Both tiers are merged: names that line up word
 * for word, and names that share one identifying word — the studio
 * confirmed that "OVI Oak Kitchen", "OVI Oak/Ballrooms" and "Carissa
 * 90826/Oak Kit" are one job, and nothing in the names themselves says so.
 *
 * This deletes rows, so the guards that remain are the ones that hold
 * whatever the names look like: two Houzz Pro imports are never fused (the
 * studio keeps those apart itself), a shared word has to appear in a handful
 * of projects rather than across the board, and every merge is written to
 * the audit log with the names it removed.
 *
 * Idempotent: a second run finds nothing left to merge.
 */
export async function autoMergeDuplicates(orgId: string): Promise<AutoMergeResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', merged: [], removed: 0, moved: 0 };

  const { groups } = await findDuplicateProjects(orgId);
  const result: AutoMergeResult = { ok: true, merged: [], removed: 0, moved: 0 };

  for (const group of groups) {
    const keepId = group.suggestedKeepId;
    const mergeIds = group.projects.map((p) => p.id).filter((id) => id !== keepId);
    if (!mergeIds.length) continue;

    // One failure must not strand the rest half-merged.
    try {
      const merged = await mergeProjects(orgId, keepId, mergeIds);
      if (!merged.ok) {
        console.error('[promote] auto-merge skipped a group:', merged.reason);
        continue;
      }
      result.merged.push({
        kept: merged.kept ?? '',
        removed: group.projects.filter((p) => p.id !== keepId).map((p) => p.name),
      });
      result.removed += merged.removed;
      result.moved += merged.moved;
    } catch (err) {
      console.error('[promote] auto-merge failed for a group:', (err as Error).message);
    }
  }

  return result;
}

export interface VendorProjectCleanup {
  ok: boolean;
  reason?: string;
  /** Project rows removed because they only ever named a vendor. */
  removed: number;
  names: string[];
}

/**
 * Delete projects that are really just a vendor under another name.
 *
 * Before `namesAProject` existed, a quote whose project could not be
 * identified fell back to the vendor, so "Schumacher Hospitality" ended up
 * as a project AND a vendor — the same company filed twice in two different
 * parts of the studio. New mail no longer does this; these are the rows
 * left behind.
 *
 * Deliberately timid, because it deletes: a project goes only when it
 * matches a vendor by name AND carries nothing that could not be recreated
 * — no purchase orders, no tasks, no spec gaps, and no Houzz id, which
 * would mean the studio keeps it as a real job. A vendor that genuinely is
 * also a project ("Schumacher" the client as well as the supplier) will
 * have work hanging off it and is left alone.
 *
 * Emails filed against it are moved to the vendor rather than orphaned, so
 * the correspondence stays findable.
 */
export async function removeVendorProjects(orgId: string): Promise<VendorProjectCleanup> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', removed: 0, names: [] };

  const [{ data: vendorRows }, projects] = await Promise.all([
    supabaseAdmin.from('vendors').select('id, name').eq('org_id', orgId),
    projectRows(orgId),
  ]);
  const vendors = (vendorRows ?? []) as { id: string; name: string }[];
  if (!vendors.length || !projects.length) return { ok: true, removed: 0, names: [] };

  const result: VendorProjectCleanup = { ok: true, removed: 0, names: [] };

  for (const project of projects) {
    // The studio's own record always wins over a name coincidence.
    if (project.houzz_ref) continue;

    const norm = normalize(project.name);
    const vendor = vendors.find((v) => sameEntity(normalize(v.name), norm));
    if (!vendor) continue;

    // Anything real hanging off it means this is a job, not a stray name.
    const [{ count: pos }, { count: tasks }, { count: gaps }] = await Promise.all([
      supabaseAdmin.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('project_id', project.id),
      supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true }).eq('project_id', project.id),
      supabaseAdmin.from('spec_gaps').select('id', { count: 'exact', head: true }).eq('project_id', project.id),
    ]);
    if ((pos ?? 0) > 0 || (tasks ?? 0) > 0 || (gaps ?? 0) > 0) continue;

    try {
      // The mail was about this vendor all along — keep it, on the vendor.
      await supabaseAdmin
        .from('emails')
        .update({ project_id: null, vendor_id: vendor.id })
        .eq('org_id', orgId)
        .eq('project_id', project.id);

      // Documents and prompt runs simply lose a link that was never right.
      for (const table of ['documents', 'prompt_runs'] as const) {
        await supabaseAdmin
          .from(table)
          .update({ project_id: null })
          .eq('org_id', orgId)
          .eq('project_id', project.id);
      }

      const { error } = await supabaseAdmin
        .from('projects')
        .delete()
        .eq('org_id', orgId)
        .eq('id', project.id);
      if (error) throw new Error(error.message);

      result.removed++;
      result.names.push(project.name);
    } catch (err) {
      console.error('[promote] could not remove vendor-project', project.name, (err as Error).message);
    }
  }

  if (result.removed) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'projects.vendor_rows_removed',
      entity: 'project',
      meta: { removed: result.removed, names: result.names },
    });
  }

  return result;
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
