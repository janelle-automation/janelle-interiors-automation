// ============================================================
//  Bring the studio's live project list into the database.
//
//  The work has been tracked in a Google Sheet ("Janelle
//  Interior: Project List") — 27 projects with a client, a
//  town, a state and sometimes a manager. This puts them in
//  `projects`, where tasks, purchase orders, spec gaps and the
//  assistant can all see them, and writes an activity row per
//  project so each one has a trail from its first day.
//
//  Usage:
//    npm run seed-projects              # import / refresh
//    npm run seed-projects -- --dry-run # show what would change
//
//  Re-runnable. A project is matched on its name within the
//  studio, so a second run updates the row it made the first
//  time rather than creating a twin. Only fields the sheet
//  actually fills are written: a stage someone set by hand in
//  the UI survives a re-import, and so does a budget, a target
//  install date or a note the sheet has no column for.
//
//  Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env,
//  and migration 0013 applied (location + sheet_status).
// ============================================================
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

const dryRun = process.argv.includes('--dry-run');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('x Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  process.exit(1);
}

// ── The sheet ───────────────────────────────────────────────
//
// Transcribed from "Janelle Interior: Project List", rows 2-28,
// in the sheet's own order and spelling.
//
// `client: null` is a cell the sheet leaves empty OR one still
// showing Google Sheets' own "Add a Client" placeholder — that
// is the absence of a client, not the name of one.
//
// `manager` is the initials the sheet's Managers column uses,
// resolved to a teammate below.
//
// `wasCalled` is the name the SAME job already carries in the
// database. Ingestion has been creating projects off email for
// months and it named them the way email does — "Pollicks",
// "Trudi Town", "SHORR" — while the sheet names them the way
// the studio writes them down. Matching on the sheet name alone
// would have left eleven projects existing twice, with the
// emails and tasks on one row and the client, town and manager
// on the other.
//
// So the sheet row UPDATES the ingested row in place: nothing is
// deleted, nothing is moved, and the project keeps every email
// and task already attached to it while taking the sheet's name.
// Each pairing below was confirmed by hand against the studio's
// list — a wrong one would hang a project's history on the wrong
// job, which is why none of them is guessed by string distance.
//
// Deliberately NOT paired, though the names tempt it:
//   NYC Cherry Lane      vs. Serge          — different jobs
//   SPA End of Year FF&E vs. OVI Spa 2026   — different jobs
// Both confirmed with the studio; they stay as they are and the
// sheet rows come in fresh alongside them.

const SHEET = [
  { name: 'AUDITS - OVIS',                    client: null,                          location: null,                 status: 'Open',        manager: 'VM' },
  { name: 'Bernthal Ojai Home',               client: 'Erin & John Bernthal',        location: 'Ojai, California',   status: 'Open',        manager: 'JR',  wasCalled: 'Bernthal Residence' },
  { name: 'Brian Coleman',                    client: 'Brian Coleman',               location: 'Ventura, California',status: 'In Progress', manager: 'VM',  wasCalled: 'Brian Coleman 644 Ventura' },
  { name: "Chamberlain's New Home",           client: 'Bob & Sue Chamberlain',       location: null,                 status: 'In Progress', manager: null,  wasCalled: 'Chamberlains' },
  { name: 'Ditchfield - Ojai Home',           client: 'Skyler and Lindsey Ditchfield',location: null,                status: 'Open',        manager: null },
  { name: 'Fred Keeler - Hitching Post',      client: 'Fred Keeler',                 location: 'Ojai, California',   status: 'Open',        manager: 'VM',  wasCalled: 'Fred Keeler' },
  { name: 'Golf OVIS (Shop & Locker Rooms)',  client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'Open',        manager: 'JR',  wasCalled: 'OVIS GOLF' },
  { name: 'Herzog Winery',                    client: 'Carole Felix',                location: 'Oxnard, California', status: 'Open',        manager: null },
  { name: 'JK Ojai House',                    client: null,                          location: null,                 status: 'Open',        manager: null },
  { name: 'Julie McManus',                    client: null,                          location: null,                 status: 'Open',        manager: 'JR' },
  { name: "Julie's bathroom",                 client: null,                          location: null,                 status: 'Open',        manager: null },
  { name: 'Lemons',                           client: 'Deb and Steve Lemon',         location: 'Ojai, California',   status: 'In Progress', manager: 'JR',  wasCalled: 'Lemon Residence' },
  { name: "MISC QUOTES- Store walk-in's, etc",client: 'Janelle Kandziora',           location: null,                 status: 'In Progress', manager: null },
  { name: 'OVI - 2023 Guestroom Refresh',     client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'Open',        manager: null },
  { name: 'OVI Farmhouse Fire',               client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'In Progress', manager: null },
  { name: 'OVI FF&E Inspections',             client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'Open',        manager: null },
  { name: 'OVI MISC',                         client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'In Progress', manager: null },
  { name: 'OVI Oak/Ballrooms FF&E 2026',      client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'Open',        manager: 'VM' },
  { name: 'OVIS FF&E Projects',               client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'In Progress', manager: null },
  { name: 'OVI Spa 2026',                     client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'In Progress', manager: 'JR' },
  { name: 'OVI Topa Courtyard FF&E',          client: 'Ojai Valley Inn & Spa',       location: 'Ojai, CA',           status: 'In Progress', manager: null },
  { name: 'Pollick Remodel',                  client: 'Josh and Dana Pollick',       location: 'Ojai, CA',           status: 'In Progress', manager: 'VM',  wasCalled: 'Pollicks' },
  { name: 'Serge',                            client: 'Kevin',                       location: 'New York, New York', status: 'Open',        manager: null },
  { name: 'Shorr Project',                    client: 'Julie Shorr',                 location: 'Ojai, CA',           status: 'In Progress', manager: null,  wasCalled: 'SHORR' },
  { name: 'Skyler Logsdon',                   client: null,                          location: null,                 status: 'In Progress', manager: null },
  { name: 'Special Projects - Overall',       client: null,                          location: null,                 status: 'Open',        manager: null },
  { name: 'Trudie Ojai Backyard project',     client: 'John and Trudie Town',        location: 'Ojai, California',   status: 'Open',        manager: 'VM',  wasCalled: 'Trudi Town' },
];

/**
 * The Managers column writes initials. Resolved by email rather
 * than by name, because an account's `full_name` is whatever
 * the person typed at sign-up and the address is not.
 *
 * Only two initials appear in the sheet and neither is
 * ambiguous against the roster in apps/api/src/lib/studioTeam.ts.
 * A third would need adding here — the script says so rather
 * than silently leaving the project unassigned.
 */
const MANAGERS = {
  VM: { name: 'Victoria Manayan', email: 'manayan.victoriam@gmail.com' },
  JR: { name: 'Joanna Ramos', email: 'ramos.joannaeve@gmail.com' },
};

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const key = (name) => name.trim().toLowerCase();

async function organizationId() {
  const { data, error } = await admin.from('organizations').select('id').limit(1);
  if (error) throw new Error(error.message);
  if (!data?.[0]?.id) {
    throw new Error('No organization exists yet. Run `npm run create-admin` or `npm run seed-team` first.');
  }
  return data[0].id;
}

/** Whether migration 0013 has run. Without it there is nowhere to put the sheet's columns. */
async function sheetColumnsAvailable() {
  const { error } = await admin.from('projects').select('location, sheet_status').limit(1);
  return !error;
}

/** Profile ids for the initials the sheet uses, by email. */
async function resolveManagers(orgId) {
  const wanted = [...new Set(SHEET.map((p) => p.manager).filter(Boolean))];
  const emails = wanted.map((i) => MANAGERS[i]?.email).filter(Boolean);

  const { data, error } = await admin
    .from('profiles')
    .select('id, email, full_name')
    .eq('org_id', orgId)
    .in('email', emails);
  if (error) throw new Error(error.message);

  const byEmail = new Map((data ?? []).map((p) => [p.email.toLowerCase(), p]));
  const resolved = new Map();
  const missing = [];

  for (const initials of wanted) {
    const person = MANAGERS[initials];
    if (!person) {
      missing.push(`${initials} — not in MANAGERS, add them to scripts/seed-projects.mjs`);
      continue;
    }
    const profile = byEmail.get(person.email.toLowerCase());
    if (!profile) {
      missing.push(`${initials} (${person.name}) — no account yet, run \`npm run seed-team\``);
      continue;
    }
    resolved.set(initials, profile);
  }
  return { resolved, missing };
}

async function main() {
  const orgId = await organizationId();

  if (!(await sheetColumnsAvailable())) {
    console.error('x Migration 0013 has not been applied — `projects` has no location/sheet_status column.');
    console.error('  Run `npm run db:apply`, or paste supabase/migrations/0013_project_sheet_fields.sql');
    console.error('  into the Supabase SQL editor, then run this again.');
    process.exit(1);
  }

  const { resolved: managers, missing } = await resolveManagers(orgId);

  // Read once and match in memory: 27 rows against a studio's
  // project list is nothing, and one query beats 27.
  const { data: existingRows, error: readErr } = await admin
    .from('projects')
    .select('id, name, stage, assigned_to')
    .eq('org_id', orgId);
  if (readErr) throw new Error(readErr.message);
  const existing = new Map((existingRows ?? []).map((p) => [key(p.name), p]));

  const created = [];
  const updated = [];

  for (const row of SHEET) {
    const manager = row.manager ? managers.get(row.manager) : null;

    // Only what the sheet actually knows. `stage`, `budget`,
    // `target_install` and `notes` are deliberately absent:
    // the sheet has no column for them, and writing a default
    // over a stage someone set by hand in the UI would undo
    // their work on every re-run.
    const fields = {
      org_id: orgId,
      name: row.name,
      client_name: row.client,
      location: row.location,
      sheet_status: row.status,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    // An unassigned row in the sheet is "nobody has been named
    // yet", not "take this project off whoever holds it".
    if (manager) fields.assigned_to = manager.id;

    // The sheet's own name first — that is what a second run
    // matches on, once the first has renamed everything. Then
    // the name ingestion gave the same job, which is what the
    // FIRST run matches on. Checking the sheet name first is
    // what makes the script idempotent: after one run the
    // ingested name is gone and only the sheet name resolves.
    const found = existing.get(key(row.name)) ?? (row.wasCalled ? existing.get(key(row.wasCalled)) : undefined);
    const renamedFrom = found && key(found.name) !== key(row.name) ? found.name : null;

    if (dryRun) {
      (found ? updated : created).push({ ...row, manager, id: found?.id ?? null, renamedFrom });
      continue;
    }

    if (found) {
      const { error } = await admin.from('projects').update(fields).eq('id', found.id);
      if (error) throw new Error(`${row.name}: ${error.message}`);
      updated.push({ ...row, manager, id: found.id, renamedFrom });
      // So a second run cannot match this row again under its
      // old name and undo the rename.
      existing.delete(key(found.name));
      existing.set(key(row.name), { ...found, name: row.name });
    } else {
      const { data, error } = await admin.from('projects').insert(fields).select('id').single();
      if (error) throw new Error(`${row.name}: ${error.message}`);
      created.push({ ...row, manager, id: data.id, renamedFrom: null });
    }
  }

  // One row per project, so each project's own trail starts
  // here rather than every project pointing at a single bulk
  // "imported 27" entry nobody can read backwards. `actor` is
  // null: a script ran this, not a person.
  if (!dryRun) {
    const trail = [...created.map((p) => ({ p, what: 'created' })), ...updated.map((p) => ({ p, what: 'updated' }))]
      .map(({ p, what }) => ({
        org_id: orgId,
        actor: null,
        action: 'projects.sheet_import',
        entity: 'project',
        entity_id: p.id,
        meta: {
          source: 'Janelle Interior: Project List (Google Sheet)',
          change: what,
          client: p.client,
          location: p.location,
          sheet_status: p.status,
          manager: p.manager?.full_name ?? null,
          // Kept so the trail explains a project that changed
          // name overnight: it was matched, not recreated.
          renamed_from: p.renamedFrom ?? null,
        },
      }));

    // Chunked: one insert of 27 is fine, but this grows with the
    // sheet and PostgREST has a limit on how much it will take.
    for (let i = 0; i < trail.length; i += 50) {
      const { error } = await admin.from('activity_log').insert(trail.slice(i, i + 50));
      if (error) console.warn(`! activity not recorded for ${trail.length} project(s): ${error.message}`);
    }
  }

  // ── Report ────────────────────────────────────────────────
  const pad = (text, width) => String(text ?? '').padEnd(width);
  const all = [...created.map((p) => ({ ...p, was: 'created' })), ...updated.map((p) => ({ ...p, was: 'updated' }))]
    .sort((a, b) => SHEET.findIndex((s) => s.name === a.name) - SHEET.findIndex((s) => s.name === b.name));

  const wide = Math.max(...all.map((p) => p.name.length));
  const clientWide = Math.max(...all.map((p) => (p.client ?? '—').length));

  console.log(`\n${dryRun ? 'Would import' : 'Imported'} ${all.length} projects:\n`);
  console.log(`  ${pad('PROJECT', wide)}  ${pad('CLIENT', clientWide)}  ${pad('LOCATION', 20)}  ${pad('SHEET', 12)}  ${pad('MANAGER', 18)}  WAS`);
  for (const p of all) {
    console.log(
      `  ${pad(p.name, wide)}  ${pad(p.client ?? '—', clientWide)}  ${pad(p.location ?? '—', 20)}  ${pad(p.status, 12)}  ${pad(p.manager?.full_name ?? '—', 18)}  ${p.was}`,
    );
  }

  const renames = all.filter((p) => p.renamedFrom);
  if (renames.length) {
    console.log(`\n  ${renames.length} projects ingestion had already created under another name were`);
    console.log('  matched and updated in place — their email and task history is intact:');
    for (const p of renames) console.log(`    ${pad(p.renamedFrom, 24)} → ${p.name}`);
  }

  console.log(`\n  ${created.length} created, ${updated.length} updated.`);
  if (!dryRun) console.log(`  ${all.length} activity rows written — each project's trail starts today.`);

  if (missing.length) {
    console.log('\n  Managers the sheet names that could not be resolved:');
    for (const m of missing) console.log(`    - ${m}`);
    console.log('    Those projects were imported unassigned.');
  }

  console.log('\n  Worth a look:');
  console.log('    - Every project is at stage "lead". The sheet only says Open or In Progress,');
  console.log('      which is not the same vocabulary as the pipeline — set real stages in the UI.');
  const placeholders = SHEET.filter((p) => !p.client).length;
  console.log(`    - ${placeholders} projects have no client (the sheet says "Add a Client" or is blank).`);
  console.log('    - "MISC QUOTES- Store walk-in\'s, etc" lists Janelle Kandziora as the client.');
  console.log('      She is the studio owner, so that is an internal bucket rather than a real');
  console.log('      client — kept verbatim here, worth clearing if it pollutes client lists.');

  if (dryRun) console.log('\n  Dry run — nothing was written. Re-run without --dry-run to apply.');
}

main().catch((err) => {
  console.error('x Failed:', err.message);
  process.exit(1);
});
