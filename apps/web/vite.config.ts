import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// One environment file for the whole monorepo.
const envDir = path.resolve(__dirname, '../..');

export default defineConfig(({ mode }) => {
  // The empty prefix loads every variable, not just VITE_*, so the client
  // can reuse the single server-side definition of the Supabase project
  // instead of a VITE_-prefixed copy that has to be kept in step.
  const env = loadEnv(mode, envDir, '');

  // EXPLICIT allowlist — these are the only values that reach the browser
  // bundle. Never widen this into a loop over `env`: the VITE_ prefix is
  // the guardrail that keeps SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
  // GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY out of client-side
  // JavaScript. Everything here is public by design: the Supabase URL and
  // the anon key are safe in a browser, because row-level security is what
  // actually protects the data.
  //
  // A VITE_-prefixed value still wins where one is set, so existing Vercel
  // and CI configurations keep working unchanged.
  const clientEnv: Record<string, string> = {
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL || env.SUPABASE_URL || '',
    VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '',
  };

  return {
    plugins: [react()],
    envDir,
    define: Object.fromEntries(
      Object.entries(clientEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]),
    ),
    server: {
      port: 5173,
      strictPort: false,
    },
  };
});
