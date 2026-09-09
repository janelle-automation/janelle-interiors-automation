import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, isSupabaseConfigured } from '../env.js';

/** True once SUPABASE_URL + both keys are present in the environment. */
export const supabaseConfigured = isSupabaseConfigured();

/**
 * Admin client — uses the service-role key and BYPASSES row-level
 * security. Use only for trusted server work. `null` until the
 * Supabase environment is configured.
 */
export const supabaseAdmin: SupabaseClient | null = supabaseConfigured
  ? createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

/**
 * Request-scoped client — carries the caller's JWT so every query
 * runs under that user's row-level-security policies. `null` until
 * the Supabase environment is configured.
 */
export function supabaseForToken(accessToken: string): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  return createClient(env.supabase.url, env.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
