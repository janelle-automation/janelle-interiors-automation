// ============================================================
//  Create (or reset) a testing ADMIN user in Supabase.
//  Creates a confirmed auth user and a `principal` profile so you
//  can sign in immediately at the app's Create-account/Sign-in screen.
//
//  Usage:
//    npm run create-admin                 # uses the defaults below
//    npm run create-admin -- a@b.com pw   # custom email + password
//
//  Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
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

const EMAIL = process.argv[2] || 'systems@janelleinteriors.com';
const PASSWORD = process.argv[3] || 'JanelleAdmin!2026';
const FULL_NAME = 'Janelle (Admin)';

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUserByEmail(email) {
  // Page through users (fine for a small studio).
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function main() {
  // 1. Create the auth user (or reset the password if it already exists).
  let userId;
  const created = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: FULL_NAME },
  });

  if (created.error) {
    const existing = await findUserByEmail(EMAIL);
    if (!existing) throw new Error(created.error.message);
    userId = existing.id;
    await admin.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: FULL_NAME },
    });
    console.log('• Existing user found — password reset.');
  } else {
    userId = created.data.user.id;
    console.log('• Auth user created.');
  }

  // 2. Ensure an organization exists.
  const { data: orgs } = await admin.from('organizations').select('id').limit(1);
  let orgId = orgs?.[0]?.id;
  if (!orgId) {
    const { data: newOrg, error } = await admin
      .from('organizations')
      .insert({
        name: 'Janelle Interiors',
        settings: { vendor_silence_days: 3, client_approval_days: 5, report_day: 'monday' },
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    orgId = newOrg.id;
    console.log('• Organization created.');
  }

  // 3. Upsert the profile as principal (admin).
  const { error: profileErr } = await admin.from('profiles').upsert({
    id: userId,
    org_id: orgId,
    email: EMAIL,
    full_name: FULL_NAME,
    role: 'principal',
  });
  if (profileErr) throw new Error(profileErr.message);
  console.log('• Profile set to principal (admin).');

  console.log('\n✓ Testing admin ready. Sign in at the app with:');
  console.log(`    Email:    ${EMAIL}`);
  console.log(`    Password: ${PASSWORD}`);
}

main().catch((err) => {
  console.error('✗ Failed:', err.message);
  process.exit(1);
});
