// ============================================================
//  Give every person on the studio roster a sign-in, all with the
//  same password, so login and role permissions can be tested.
//
//  The roster in apps/api/src/lib/studioTeam.ts says who the studio's
//  people are; the seat each one holds carries the role that seat is
//  allowed (SEATS in packages/shared). This turns that paper roster
//  into accounts that can actually sign in:
//
//      confirmed auth user (password set) + profiles row (role, seat)
//
//  Usage:
//    npm run seed-team                    # password from TEAM_DEFAULT_PASSWORD
//    npm run seed-team -- somePassw0rd    # password on the command line
//    npm run seed-team -- --with-admin    # also reset systems@ (principal)
//
//  Re-runnable: an account that already exists keeps its id and has its
//  password reset and its role and seat corrected.
//
//  Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
//  TEAM_DEFAULT_PASSWORD in .env, and a build (npm run build) so the
//  roster is read from the same source the API reads it from.
// ============================================================
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

const args = process.argv.slice(2);
const withAdmin = args.includes('--with-admin');
const passwordArg = args.find((a) => !a.startsWith('--'));

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
// `Password` is accepted too: it is what the key was first called in .env.
const PASSWORD = passwordArg || process.env.TEAM_DEFAULT_PASSWORD || process.env.Password;

if (!url || !serviceKey) {
  console.error('x Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  process.exit(1);
}
if (!PASSWORD) {
  console.error('x No password. Set TEAM_DEFAULT_PASSWORD in .env, or pass one: npm run seed-team -- myPassw0rd');
  process.exit(1);
}
if (PASSWORD.length < 6) {
  console.error('x Supabase requires at least 6 characters.');
  process.exit(1);
}

// The roster and the seat table are read from the build, so this script and
// the API can never disagree about who is on the team.
const rosterPath = path.resolve(here, '..', 'apps', 'api', 'dist', 'lib', 'studioTeam.js');
if (!fs.existsSync(rosterPath)) {
  console.error('x Build first so the roster can be read: npm run build');
  process.exit(1);
}
const { STUDIO_TEAM, STUDIO_MAILBOXES } = await import(pathToFileURL(rosterPath).href);
const { SEATS } = await import('@janelle/shared');

/** A teammate the roles document gives no seat still gets the smallest role. */
const ROLE_WITHOUT_SEAT = 'assistant';

const held = new Set();
const people = STUDIO_TEAM.map((person) => {
  const role = (person.seat && SEATS[person.seat]?.role) || ROLE_WITHOUT_SEAT;
  // One seat, one holder — the rule the Team screen enforces. Both designers
  // share the design seat on paper, so the second keeps the designer role
  // and holds no seat.
  const seat = person.seat && !held.has(person.seat) ? person.seat : null;
  if (seat) held.add(seat);
  return { name: person.name, email: person.email, role, seat, shares: person.seat && !seat ? person.seat : null };
});

if (withAdmin) {
  // The shared mailbox, not a person: it signs in and connects Gmail.
  people.push({ name: 'Janelle (Admin)', email: STUDIO_MAILBOXES[0], role: 'principal', seat: null, shares: null });
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Every existing auth user, by lower-cased address (fine for a small studio). */
async function existingUsers() {
  const byEmail = new Map();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    for (const user of data.users) if (user.email) byEmail.set(user.email.toLowerCase(), user);
    if (data.users.length < 200) break;
  }
  return byEmail;
}

async function organizationId() {
  const { data: orgs, error } = await admin.from('organizations').select('id').limit(1);
  if (error) throw new Error(error.message);
  if (orgs?.[0]?.id) return orgs[0].id;

  const { data: created, error: insertErr } = await admin
    .from('organizations')
    .insert({
      name: 'Janelle Interiors',
      settings: { vendor_silence_days: 3, client_approval_days: 5, report_day: 'monday' },
    })
    .select('id')
    .single();
  if (insertErr) throw new Error(insertErr.message);
  console.log('- Organization created.');
  return created.id;
}

/** Seats only exist on profiles after migration 0008. */
async function seatsAvailable() {
  const { error } = await admin.from('profiles').select('seat').limit(1);
  return !error;
}

async function main() {
  const orgId = await organizationId();
  const hasSeat = await seatsAvailable();
  if (!hasSeat) {
    console.log('- No seat column yet (migration 0008 unapplied) — roles are set, seats are skipped.\n');
  }

  const found = await existingUsers();
  const done = [];

  for (const person of people) {
    const email = person.email.toLowerCase();
    let userId = found.get(email)?.id;
    let state;

    if (userId) {
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: person.name },
      });
      if (error) throw new Error(`${email}: ${error.message}`);
      state = 'password reset';
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: person.name },
      });
      if (error) throw new Error(`${email}: ${error.message}`);
      userId = data.user.id;
      state = 'created';
    }

    const profile = { id: userId, org_id: orgId, email, full_name: person.name, role: person.role };
    if (hasSeat) profile.seat = person.seat;
    const { error: profileErr } = await admin.from('profiles').upsert(profile);
    if (profileErr) throw new Error(`${email}: ${profileErr.message}`);

    done.push({ ...person, state });
  }

  const pad = (text, width) => String(text).padEnd(width);
  const wide = Math.max(...done.map((p) => p.email.length));

  console.log(`\n${done.length} sign-ins ready — one password for all of them:\n`);
  console.log(`  ${pad('EMAIL', wide)}  ${pad('ROLE', 12)}  ${pad('SEAT', 22)}  WAS`);
  for (const person of done) {
    console.log(`  ${pad(person.email, wide)}  ${pad(person.role, 12)}  ${pad(person.seat ?? '-', 22)}  ${person.state}`);
  }
  console.log(`\n  Password: ${PASSWORD}`);

  for (const person of done.filter((p) => p.shares)) {
    console.log(`\n  Note: ${person.name} shares the "${person.shares}" seat on paper. One seat holds one`);
    console.log('        person, so she keeps the role and holds no seat. Swap it on Team & roles.');
  }
  console.log('\n  Sign in at the web app with the email and that password. Google sign-in is separate —');
  console.log('  a password here does not change it.');
}

main().catch((err) => {
  console.error('x Failed:', err.message);
  process.exit(1);
});
