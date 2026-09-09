import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when the app has been pointed at a real Supabase project. */
export const supabaseConfigured = Boolean(url && anon);

/**
 * Browser Supabase client. When env is not yet set (fresh checkout),
 * this is null and the app shows the setup screen.
 */
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url as string, anon as string)
  : null;
