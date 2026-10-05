#!/usr/bin/env bash
# Pull, build and restart on the server. Run from the repo root:
#   bash deploy/deploy.sh
set -euo pipefail
git pull --ff-only
npm ci
npm run build
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save
echo "Deployed $(git rev-parse --short HEAD)"
