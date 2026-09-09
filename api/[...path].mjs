// Vercel serverless entry for the Express API.
//
// Vercel scans this top-level `api/` directory for functions. The catch-all
// filename means every request to /api/* is handled here with its original
// path intact, which is what the Express app mounts its routers on.
//
// The compiled app comes from `apps/api/dist`, produced by the root
// `npm run build` that vercel.json runs before functions are bundled.
import app from '../apps/api/dist/app.js';

export default function handler(req, res) {
  // The app's routers live under /api/*. Vercel's catch-all preserves that
  // prefix; this guard keeps the function working if it ever arrives stripped.
  if (!req.url || !req.url.startsWith('/api')) {
    req.url = `/api${req.url && req.url.startsWith('/') ? req.url : `/${req.url ?? ''}`}`;
  }
  return app(req, res);
}
