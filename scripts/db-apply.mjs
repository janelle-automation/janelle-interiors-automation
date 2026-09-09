// ============================================================
//  Migration runner — applies supabase/schema.sql (and optionally
//  supabase/seed.sql) over a direct Postgres connection.
//
//  Usage:
//    node scripts/db-apply.mjs            # schema only
//    node scripts/db-apply.mjs --seed     # schema + seed
//
//  Connection is read from SUPABASE_DB_URL in the repo-root .env,
//  e.g. postgresql://postgres:[PW]@db.<ref>.supabase.co:5432/postgres
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
loadEnv({ path: path.join(root, '.env') });

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('✗ SUPABASE_DB_URL is not set in .env');
  console.error('  Format: postgresql://postgres:[DB-PASSWORD]@db.<project-ref>.supabase.co:5432/postgres');
  process.exit(1);
}

const withSeed = process.argv.includes('--seed');

async function runFile(client, relPath) {
  const sql = readFileSync(path.join(root, relPath), 'utf8');
  process.stdout.write(`  → applying ${relPath} … `);
  await client.query(sql);
  console.log('done');
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS
});

try {
  await client.connect();
  console.log('✓ connected to Supabase Postgres');
  await runFile(client, 'supabase/schema.sql');
  if (withSeed) await runFile(client, 'supabase/seed.sql');
  console.log('✓ migration complete');
} catch (err) {
  console.error('✗ migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
