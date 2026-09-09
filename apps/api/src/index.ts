import app from './app.js';
import { env, isSupabaseConfigured } from './env.js';
import { startScheduler } from './services/scheduler.js';

/**
 * Local / self-hosted entry point: a long-running Node server.
 *
 * On Vercel this file is never loaded — a serverless function cannot listen
 * on a port or hold cron timers. There, `api/[...path].mjs` serves the same
 * app and the scheduled work runs from Vercel Cron instead
 * (see docs/DEPLOY-VERCEL.md).
 */
app.listen(env.port, env.host, () => {
  console.log(`  ▸ Janelle API listening on http://${env.host}:${env.port}`);
  console.log(`  ▸ CORS origins: ${env.corsOrigins.join(', ') || '(any)'}`);
  if (!isSupabaseConfigured()) {
    console.warn('  ⚠ Supabase not configured — data & auth routes return 503 until keys are set in .env');
  }
  startScheduler();
});
