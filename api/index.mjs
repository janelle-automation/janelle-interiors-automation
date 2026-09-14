// Vercel serverless entry for the Express API.
//
// One function serves every /api/* route. vercel.json rewrites the whole
// prefix here and carries the real path in `__path`, because a filename
// catch-all (`api/[...path].mjs`) only ever matched ONE segment in this
// project: /api/me reached Express, /api/dashboard/summary returned
// Vercel's own NOT_FOUND page without the function ever running.
//
// The compiled app comes from `apps/api/dist`, produced by the root
// `npm run build` that vercel.json runs before functions are bundled.
import app from '../apps/api/dist/app.js';

export default function handler(req, res) {
  const raw = req.url ?? '/';
  const [pathname, search = ''] = raw.split('?');
  const params = new URLSearchParams(search);

  // The rewrite hands us the original path. Prefer it, and take the rest of
  // the query with it so nothing the caller sent is lost.
  const forwarded = params.get('__path');
  if (forwarded) {
    params.delete('__path');
    const rest = params.toString();
    req.url = rest ? `${forwarded}?${rest}` : forwarded;
  } else if (!pathname.startsWith('/api')) {
    // Belt and braces: if the prefix ever arrives stripped, put it back.
    req.url = `/api${pathname.startsWith('/') ? '' : '/'}${raw}`;
  }

  return app(req, res);
}
