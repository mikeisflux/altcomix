#!/bin/bash
# ============================================================================
# NSFWComix deploy: pull -> npm ci -> build web -> migrate -> reload.
#
#   cd /srv/nsfwcomix && ./scripts/deploy/deploy.sh
#
# Run it as the user that owns the checkout and the PM2 process (not root).
# Stops at the first failing step; the running site is only touched by the
# last step, so a failed install or build leaves the old version serving.
#
# Options:
#   --no-pull    deploy the checkout as it is (after a manual git checkout)
#   --restart    full restart instead of a rolling reload
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
cd "$ROOT"

PULL=1
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --restart) RESTART=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { echo; echo "==> $*"; }

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 is not installed (npm install -g pm2)" >&2; exit 1; }
[ -f .env ] || { echo "No .env in $ROOT. Copy .env.example and fill it in first (see docs/DEPLOY.md)." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 26 ] || { echo "Node 26 or newer is required (found $(node -v))" >&2; exit 1; }

BEFORE="$(git rev-parse HEAD)"

if [ "$PULL" = 1 ]; then
  step "Pulling"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "The checkout has local changes. Commit, stash or discard them first:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
  git pull --ff-only
fi
AFTER="$(git rev-parse HEAD)"
echo "Version: ${BEFORE:0:9} -> ${AFTER:0:9}"

step "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund

step "Building the web client"
npm run build

step "Running database migrations"
npm run migrate

step "Reloading"
if ! pm2 describe nsfwcomix >/dev/null 2>&1; then
  pm2 start scripts/deploy/ecosystem.config.cjs
  pm2 save
elif [ "$RESTART" = 1 ] || ! git diff --quiet "$BEFORE" "$AFTER" -- scripts/deploy/ecosystem.config.cjs scripts/deploy/cluster.mjs; then
  # The launcher or its PM2 settings changed: only a full restart picks that up (a few seconds of downtime).
  pm2 restart scripts/deploy/ecosystem.config.cjs --update-env
else
  # Rolling: the launcher replaces its workers one at a time.
  pm2 sendSignal SIGHUP nsfwcomix
fi

step "Checking health"
PORT="$(grep -E '^PORT=' .env | tail -n 1 | cut -d= -f2 || true)"
PORT="${PORT:-4000}"
for i in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Healthy. Deployed ${AFTER:0:9}."
    exit 0
  fi
  sleep 2
done
echo "The API did not answer /api/health within 60 seconds. Check: pm2 logs nsfwcomix" >&2
echo "To go back: git checkout ${BEFORE} && ./scripts/deploy/deploy.sh --no-pull" >&2
exit 1
