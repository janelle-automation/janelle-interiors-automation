// ============================================================
//  What Claude is actually costing, by feature.
//
//    npm run ai-usage            # the last 1000 calls
//    npm run ai-usage -- 200     # the last 200
//
//  Reads the same `activity_log` rows the usage report reads, and
//  answers the two questions a bill raises: which feature is
//  spending it, and how much of that spend is the same prefix
//  being resent rather than anything new being said.
// ============================================================
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('✗ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  process.exit(1);
}

const limit = Number(process.argv[2]) || 1000;
const budget = Number(process.env.AI_TOKEN_BUDGET || 5_000);

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await db
  .from('activity_log')
  .select('meta, created_at')
  .eq('action', 'ai.usage')
  .order('created_at', { ascending: false })
  .limit(limit);
if (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const rows = (data ?? []).map((r) => r.meta ?? {});
if (!rows.length) {
  console.log('No AI calls logged yet.');
  process.exit(0);
}

const by = new Map();
let cacheWrite = 0;
let cacheRead = 0;
let over = 0;

for (const m of rows) {
  const fresh = m.input_tokens ?? 0;
  const write = m.cache_write_tokens ?? 0;
  const read = m.cache_read_tokens ?? 0;
  const out = m.output_tokens ?? 0;
  cacheWrite += write;
  cacheRead += read;
  if (fresh + write + read + out > budget) over += 1;

  const f = m.feature ?? 'unknown';
  const e = by.get(f) ?? { n: 0, in: 0, out: 0, cost: 0, worst: 0, failed: 0 };
  e.n += 1;
  e.in += fresh + write + read;
  e.out += out;
  e.cost += m.cost_usd ?? 0;
  e.worst = Math.max(e.worst, fresh + write + read + out);
  if (m.ok === false) e.failed += 1;
  by.set(f, e);
}

const n = (v, w) => String(Math.round(v)).padStart(w);
console.log(`${rows.length} calls · budget ${budget} tokens/call\n`);
console.log('feature                 calls   avg in  avg out    avg     worst    failed      cost');
let total = 0;
for (const [f, e] of [...by.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
  total += e.cost;
  console.log(
    f.padEnd(22) +
      n(e.n, 6) + n(e.in / e.n, 9) + n(e.out / e.n, 9) +
      n((e.in + e.out) / e.n, 8) + n(e.worst, 10) + n(e.failed, 9) +
      ('$' + e.cost.toFixed(2)).padStart(10),
  );
}
console.log('—'.repeat(84));
console.log(`${String(rows.length).padStart(28)} calls${' '.repeat(43)}$${total.toFixed(2)}`);

console.log(`\nover budget: ${over} of ${rows.length} calls`);
console.log(
  cacheRead || cacheWrite
    ? `caching: ${cacheRead.toLocaleString()} tokens read at 0.1x, ${cacheWrite.toLocaleString()} written at 1.25x`
    : 'caching: not seen in these calls — the prefix is being paid for in full every time',
);
