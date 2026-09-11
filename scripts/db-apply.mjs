// ============================================================
//  Migration runner — applies the ordered files in
//  supabase/migrations/ exactly once each, tracked in a
//  schema_migrations table, then optionally supabase/seed.sql.
//
//  Usage:
//    node scripts/db-apply.mjs            # pending migrations
//    node scripts/db-apply.mjs --seed     # migrations + seed
//    node scripts/db-apply.mjs --status   # what is applied, what is pending
//
//  Adding a change: create the next numbered file in
//  supabase/migrations/ (e.g. 0005_something.sql). Never edit a
//  migration that has already run anywhere — write a new one.
//
//  Connection is read from SUPABASE_DB_URL in the repo-root .env,
//  e.g. postgresql://postgres:[PW]@db.<ref>.supabase.co:5432/postgres
// ============================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
loadEnv({ path: path.join(root, '.env') });

const MIGRATIONS_DIR = path.join(root, 'supabase', 'migrations');

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('✗ SUPABASE_DB_URL is not set in .env');
  console.error('  Format: postgresql://postgres:[DB-PASSWORD]@db.<project-ref>.supabase.co:5432/postgres');
  process.exit(1);
}

const withSeed = process.argv.includes('--seed');
const statusOnly = process.argv.includes('--status');

function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`✗ no migrations directory at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  // Numeric prefix defines the order; plain sort is correct while the
  // prefixes stay zero-padded and the same width.
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on some
 * PostgreSQL versions. Such a file is applied without the surrounding
 * transaction; everything else gets all-or-nothing safety.
 */
const needsNoTransaction = (sql) => /alter\s+type\s+[^;]*add\s+value/i.test(sql);

async function ensureTracking(client) {
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    );
  `);
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS
});

try {
  await client.connect();
  console.log('✓ connected to Supabase Postgres');
  await ensureTracking(client);

  const { rows: appliedRows } = await client.query('select name, checksum from schema_migrations');
  const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));
  const files = migrationFiles();

  if (statusOnly) {
    console.log('\n  migration                          state');
    console.log('  ────────────────────────────────── ──────────');
    for (const f of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const known = applied.get(f);
      const state = !known ? 'pending' : known === sha(sql) ? 'applied' : 'CHANGED since applied';
      console.log(`  ${f.padEnd(34)} ${state}`);
    }
    console.log('');
  } else {
    let ran = 0;
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha(sql);
      const known = applied.get(file);

      if (known) {
        if (known !== checksum) {
          // Editing an applied migration means two databases silently differ.
          console.warn(`  ! ${file} has changed since it was applied — add a new migration instead`);
        }
        continue;
      }

      const solo = needsNoTransaction(sql);
      process.stdout.write(`  → ${file}${solo ? ' (no transaction)' : ''} … `);
      try {
        if (!solo) await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
        if (!solo) await client.query('commit');
        console.log('done');
        ran++;
      } catch (err) {
        if (!solo) await client.query('rollback').catch(() => {});
        console.log('failed');
        throw new Error(`${file}: ${err.message}`);
      }
    }
    console.log(ran === 0 ? '  (nothing pending)' : `✓ applied ${ran} migration(s)`);

    if (withSeed) {
      process.stdout.write('  → supabase/seed.sql … ');
      await client.query(readFileSync(path.join(root, 'supabase', 'seed.sql'), 'utf8'));
      console.log('done');
    }
    console.log('✓ database up to date');
  }
} catch (err) {
  console.error('✗ migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
