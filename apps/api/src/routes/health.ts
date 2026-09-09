import { Router } from 'express';
import { isGoogleConfigured, isSupabaseConfigured, isAnthropicConfigured } from '../env.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'janelle-api',
    time: new Date().toISOString(),
    integrations: {
      supabase: isSupabaseConfigured() ? 'configured' : 'not_configured',
      google: isGoogleConfigured() ? 'configured' : 'not_configured',
      anthropic: isAnthropicConfigured() ? 'configured' : 'not_configured',
    },
  });
});
