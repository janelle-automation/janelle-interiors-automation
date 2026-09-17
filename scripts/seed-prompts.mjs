// ============================================================
//  Load the studio's prompt library into Supabase.
//
//    npm run seed-prompts            # every organization
//    npm run seed-prompts -- <orgId> # just one
//    npm run seed-prompts -- --dry   # show what would change
//
//  Deliberately goes through PostgREST with the service-role key
//  rather than the migration runner: this writes rows, not schema,
//  and `npm run db:apply` is still blocked on SUPABASE_DB_URL
//  holding the project URL instead of a Postgres connection string.
//
//  Idempotent. Matches on (org_id, title): a prompt whose template,
//  description, category or variables have drifted is updated in
//  place, so editing scripts/prompt-library.mjs and re-running is
//  the supported way to revise the library.
// ============================================================
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { PROMPT_LIBRARY, validateLibrary } from './prompt-library.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('✗ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const onlyOrg = args.find((a) => !a.startsWith('--')) ?? null;

// A template that does not match its declared variables would fail at
// run time with a confusing "Missing required inputs", so it never
// reaches the database.
const problems = validateLibrary();
if (problems.length) {
  console.error('✗ prompt-library.mjs is inconsistent:');
  for (const p of problems) console.error('   ' + p);
  process.exit(1);
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Same row, ignoring key order in `variables`. */
function unchanged(row, wanted) {
  return (
    row.category === wanted.category &&
    (row.description ?? '') === wanted.description &&
    row.template === wanted.template &&
    JSON.stringify(row.variables ?? []) === JSON.stringify(wanted.variables)
  );
}

async function seedOrg(org) {
  const { data: existing, error } = await db
    .from('prompts')
    .select('id, title, category, description, template, variables')
    .eq('org_id', org.id);
  if (error) throw new Error(`reading prompts: ${error.message}`);

  const byTitle = new Map((existing ?? []).map((r) => [r.title, r]));
  const toInsert = [];
  const toUpdate = [];
  let same = 0;

  for (const p of PROMPT_LIBRARY) {
    // A renamed prompt is the same prompt: follow it to its old title so
    // the revision lands on the existing row instead of leaving the
    // superseded one sitting in the library beside it.
    const row = byTitle.get(p.title) ?? (p.renamedFrom ? byTitle.get(p.renamedFrom) : undefined);
    if (!row) {
      toInsert.push({
        org_id: org.id,
        title: p.title,
        category: p.category,
        description: p.description,
        template: p.template,
        variables: p.variables,
      });
    } else if (row.title === p.title && unchanged(row, p)) {
      same += 1;
    } else {
      toUpdate.push({ id: row.id, p, was: row.title === p.title ? null : row.title });
    }
  }

  console.log(`\n${org.name ?? org.id}`);
  console.log(`  ${existing?.length ?? 0} prompt(s) on file · ${toInsert.length} to add · ${toUpdate.length} to update · ${same} unchanged`);

  if (dryRun) {
    for (const r of toInsert) console.log(`  + ${r.title}`);
    for (const u of toUpdate) console.log(u.was ? `  ~ ${u.was} → ${u.p.title}` : `  ~ ${u.p.title}`);
    return;
  }

  if (toInsert.length) {
    const { error: insErr } = await db.from('prompts').insert(toInsert);
    if (insErr) throw new Error(`inserting: ${insErr.message}`);
    for (const r of toInsert) console.log(`  + ${r.title}`);
  }

  for (const { id, p, was } of toUpdate) {
    const { error: updErr } = await db
      .from('prompts')
      .update({
        title: p.title,
        category: p.category,
        description: p.description,
        template: p.template,
        variables: p.variables,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (updErr) throw new Error(`updating "${p.title}": ${updErr.message}`);
    console.log(was ? `  ~ ${was} → ${p.title}` : `  ~ ${p.title}`);
  }
}

async function main() {
  let q = db.from('organizations').select('id, name');
  if (onlyOrg) q = q.eq('id', onlyOrg);
  const { data: orgs, error } = await q;
  if (error) throw new Error(`reading organizations: ${error.message}`);
  if (!orgs?.length) {
    console.error(onlyOrg ? `✗ No organization ${onlyOrg}.` : '✗ No organizations yet — sign in once to create one.');
    process.exit(1);
  }

  console.log(`${PROMPT_LIBRARY.length} prompts in the library · ${orgs.length} organization(s)${dryRun ? ' · DRY RUN' : ''}`);
  for (const org of orgs) await seedOrg(org);
  console.log(dryRun ? '\nDry run — nothing written.' : '\n✓ Prompt library up to date.');
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
