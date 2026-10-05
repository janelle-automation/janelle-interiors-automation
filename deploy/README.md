# Self-hosting on dev-build.in (node-cron instead of Vercel)

One Ubuntu server runs everything: nginx serves the web build and proxies
`/api/*` to the Express API, which PM2 keeps alive. The API process runs
`apps/api/src/services/scheduler.ts` (node-cron), which replaces both
Vercel Cron and Supabase pg_cron. No 60-second limit, no invocation count.

## 1. Server, once

```bash
# Node 20, nginx, certbot, PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx git
sudo npm i -g pm2

sudo mkdir -p /var/www && sudo chown $USER /var/www
git clone https://github.com/janelle-automation/janelle-interiors-automation.git /var/www/janelle-automation
cd /var/www/janelle-automation
```

## 2. `.env` in the repo root

Copy the Vercel environment variables (Vercel → Settings → Environment
Variables), then change the ones tied to the address:

```
CORS_ORIGINS=https://dev-build.in
GOOGLE_REDIRECT_URI=https://dev-build.in/api/auth/google/callback
```

Leave `VITE_API_BASE_URL` unset: the web app then calls `/api` on its own
origin. Do not set `PORT` (PM2 sets `API_HOST`/`API_PORT`).

## 3. Build and start

```bash
bash deploy/deploy.sh          # npm ci, build, pm2 start
pm2 startup                    # prints one sudo command; run it so PM2 survives reboots
pm2 logs janelle-api           # expect "Scheduler started (...)"
```

## 4. nginx + HTTPS

DNS first: an `A` record for `dev-build.in` pointing at the server's IP.

```bash
sudo cp deploy/nginx-dev-build.in.conf /etc/nginx/sites-available/janelle
sudo ln -s /etc/nginx/sites-available/janelle /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dev-build.in
```

## 5. Point the outside services at the new address

- Google Cloud Console → OAuth client: add the redirect URI above and
  `https://dev-build.in` as a JavaScript origin.
- Supabase → Authentication → URL Configuration: Site URL and redirect URLs.
- Slack app settings, if it uses event or interactivity URLs.

## 6. Switch off the old clocks

Only once `https://dev-build.in` works and the logs show the scheduler:

- Supabase SQL editor: run `supabase/migrations/0031_stop_pg_cron_for_node_cron.sql`.
- Vercel: leave the project paused, or delete it. Its `vercel.json` crons
  only run while it is deployed.

## Alternative: keep the site on Vercel, run only the jobs here

The background jobs are what use Vercel's CPU (reading mail, PDFs, Slack).
Run them on any always-on machine and leave Vercel just serving people:

```bash
cd /var/www/janelle-automation            # .env as in step 2 (only Supabase,
npm ci && npm run build                   # Google, Anthropic, Slack keys needed)
pm2 start apps/api/dist/worker.js --name janelle-worker
pm2 save && pm2 startup
pm2 logs janelle-worker                   # expect "Scheduler started (...)"
```

Then run migration 0031 so Supabase stops calling Vercel. Skip steps 3–5:
no nginx, no domain change. Run the worker **or** the self-hosted API, never
both.

## Updating

`bash deploy/deploy.sh` on the server after each merge to `main`.

## Notes

- **One API instance only.** The scheduler lives in the API process;
  `ecosystem.config.cjs` pins `instances: 1`.
- **Dev machines:** `npm run dev` starts the scheduler too. The claim fields
  stop it doing a job the server already did, but it would still process
  production mail with your local code. Put `SCHEDULER=off` in a dev `.env`.
