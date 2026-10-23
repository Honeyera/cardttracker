#!/usr/bin/env bash
# Deploy the personal cardtracker site (https://cards.vowideas.com).
# Builds from the CURRENT files in this folder and publishes them live
# (nginx serves dist/ directly, so there is nothing to restart).
# Also backs the code up to GitHub (personal branch) if anything changed.
set -euo pipefail
cd "$(dirname "$0")"

# 1) Publish: build the site from whatever is in this folder right now.
npm install --no-audit --no-fund
npm run build
echo "✓ Live: https://cards.vowideas.com"

# 2) Backup: commit & push any code changes to GitHub (skips .env — gitignored).
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "site update $(date -u +%Y-%m-%dT%H:%MZ)"
  git push -q origin personal && echo "✓ Backed up to GitHub (personal branch)"
else
  echo "• No code changes to back up"
fi
