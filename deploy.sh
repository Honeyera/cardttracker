#!/usr/bin/env bash
#
# Deploy cardtracker to production.
#
#   dev VPS (51.81.84.11)  --(build)-->  dist/  --(rsync)-->  nginx @ 135.148.47.180
#
# Production serves the static build from /var/www/cardtracker/dist. The app
# talks to Supabase (zndyokpudijoidropdou) directly from the browser, so there
# is nothing to restart on the prod box — nginx picks up new files immediately.
#
# Usage: ./deploy.sh
#
set -euo pipefail

PROD_HOST="ubuntu@135.148.47.180"
PROD_ROOT="/var/www/cardtracker/dist"
SITE="https://cardtracker.honeyera.com"

cd "$(dirname "$0")"

# ── Preflight: git is the source of truth for what ships ──────────────
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "✗ On branch '$branch', not main. Deploy from main." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty. Commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

git fetch -q origin
if [ -n "$(git log origin/main..HEAD --oneline)" ]; then
  echo "✗ Local commits not pushed to GitHub. Run: git push origin main" >&2
  git log origin/main..HEAD --oneline >&2
  exit 1
fi

echo "→ Deploying $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"

# ── Build ─────────────────────────────────────────────────────────────
echo "→ Building..."
npm run build

[ -f dist/index.html ] || { echo "✗ dist/index.html missing — build produced nothing" >&2; exit 1; }

# Guard: never ship a secret in the client bundle. VITE_* vars are inlined
# into the JS, so a service-role key or AI key here would be world-readable.
# (The Supabase anon key is safe — it is designed to ship to the browser.)
if grep -rqE "(sk-ant-|service_role|SUPABASE_SERVICE)" dist/ 2>/dev/null; then
  echo "✗ ABORT: a secret appears to be baked into the build." >&2
  exit 1
fi

# ── Ship ──────────────────────────────────────────────────────────────
# No --delete: old hashed assets stay so users mid-session don't 404 on a
# chunk their cached index.html still references.
echo "→ Syncing to $PROD_HOST:$PROD_ROOT ..."
rsync -az --checksum \
  -e "ssh -o BatchMode=yes" \
  --rsync-path="sudo rsync" \
  dist/ "$PROD_HOST:$PROD_ROOT/"

# ── Verify what's actually live ───────────────────────────────────────
echo "→ Verifying..."
local_js=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
live_js=$(curl -s --max-time 20 "$SITE/index.html" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)

if [ "$local_js" = "$live_js" ]; then
  echo "✓ Live at $SITE — serving $live_js"
else
  echo "✗ Mismatch: built '$local_js' but site serves '$live_js'" >&2
  echo "  index.html is set no-cache, so this usually means the sync failed." >&2
  exit 1
fi
