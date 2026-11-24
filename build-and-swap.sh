#!/bin/bash
# ============================================================================
# NSFWComix build and swap
#
#   cd /srv/nsfwcomix && ./build-and-swap.sh
#
# Pulls a branch, installs what changed, type-checks, builds the web app next
# to the live one, applies database migrations, swaps the new build in, and
# reloads PM2. If any step before the swap fails, the site keeps running the
# old version untouched.
#
# Same flow as the IndieCrowdfund script of the same name, with two
# differences in what the steps do:
#   - There is no Prisma here. The database step runs the plain SQL files in
#     api/src/migrations that have not been applied yet (`npm run migrate`).
#   - The API has no build step (Node runs the TypeScript directly), so only
#     the web app is built and swapped.
#
# Options (all optional; with none it asks which branch to pull):
#   --branch NAME       pull this branch without asking
#   --no-pull           deploy the checkout as it is
#   --restart           full PM2 restart instead of a rolling reload
#   --skip-typecheck    skip step 3 (not recommended)
# ============================================================================

REPO_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$REPO_DIR" || exit 1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_NAME="nsfwcomix"
KEEP_BACKUPS=3

BRANCH=""
PULL=1
RESTART=0
TYPECHECK=1
ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift ;;
    --no-pull) PULL=0 ;;
    --restart) RESTART=1 ;;
    --skip-typecheck) TYPECHECK=0 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}" >&2; exit 2 ;;
  esac
  shift
done

fail() {
  echo ""
  echo -e "${RED}FAILED: $1${NC}"
  echo -e "${YELLOW}The live site was not changed and is still running the previous version.${NC}"
  rm -rf "$REPO_DIR/web/dist-new"
  exit 1
}

echo "Starting build and swap for ${APP_NAME}"
echo "=================================="
START_TIME=$(date +%s)

command -v node >/dev/null || fail "node is not on PATH"
command -v pm2 >/dev/null || fail "pm2 is not installed (npm install -g pm2)"
[ -f .env ] || fail "No .env in $REPO_DIR. Copy .env.example and fill it in first (docs/DEPLOY.md)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 26 ] || fail "Node 26 or newer is required (found $(node -v))"

BEFORE="${BUILD_SWAP_BEFORE:-$(git rev-parse HEAD)}"

# ---------------------------------------------------------------------------
# Step 1: Pull
#
# The pull can update this very script. Bash reads a script by byte offset as
# it runs, so carrying on after the file changed underneath would execute a
# mix of old and new. If the script changed we hand over to the new copy;
# BUILD_SWAP_REEXECED stops the second pass from asking or pulling again.
# ---------------------------------------------------------------------------
echo ""
if [ "${BUILD_SWAP_REEXECED:-}" = "1" ]; then
  echo "Step 1: Pull latest changes... (already pulled; now running the updated script)"
elif [ "$PULL" = 0 ]; then
  echo "Step 1: Pull latest changes... skipped (--no-pull)"
else
  echo "Step 1: Pull latest changes..."
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    fail "The checkout has local changes (listed above). Commit, stash or discard them, then run this again."
  fi

  CURRENT_BRANCH="$(git branch --show-current)"
  if [ -z "$BRANCH" ]; then
    echo ""
    echo "   Current branch: ${CURRENT_BRANCH:-(none)}"
    echo ""
    echo "   Remote branches:"
    git ls-remote --heads origin 2>/dev/null | sed 's#.*refs/heads/#     #' | head -20
    echo ""
    read -r -p "Enter branch to pull from [${CURRENT_BRANCH}]: " BRANCH
    BRANCH="${BRANCH:-$CURRENT_BRANCH}"
  fi
  [ -n "$BRANCH" ] || fail "No branch given"
  echo "   Pulling from: ${BRANCH}"

  SELF_HASH_BEFORE="$(md5sum "$REPO_DIR/build-and-swap.sh" | cut -d' ' -f1)"

  # Fetch the branch by name into a remote-tracking ref (works in single-branch clones too).
  git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" || fail "Could not fetch '${BRANCH}' from origin"
  if [ "$BRANCH" != "$CURRENT_BRANCH" ]; then
    git checkout -B "$BRANCH" "origin/${BRANCH}" || fail "Could not switch to '${BRANCH}'"
  else
    git merge --ff-only "origin/${BRANCH}" || fail "The local branch has commits that are not on origin/${BRANCH}; it cannot be fast-forwarded"
  fi
  echo -e "${GREEN}   Now at $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)${NC}"

  if [ "$(md5sum "$REPO_DIR/build-and-swap.sh" | cut -d' ' -f1)" != "$SELF_HASH_BEFORE" ]; then
    echo -e "${YELLOW}   This script was updated by the pull; restarting with the new version...${NC}"
    BUILD_SWAP_REEXECED=1 BUILD_SWAP_BEFORE="$BEFORE" exec "$REPO_DIR/build-and-swap.sh" "${ARGS[@]}"
  fi
fi
AFTER="$(git rev-parse HEAD)"
echo "   Version: ${BEFORE:0:9} -> ${AFTER:0:9}"

# ---------------------------------------------------------------------------
# Step 2: Dependencies
#
# `npm ci` installs exactly what package-lock.json says and never rewrites it.
# It is skipped when the lockfile is unchanged since the last install: the
# lockfile's hash is stamped inside node_modules, so wiping node_modules also
# wipes the stamp and forces a reinstall.
# ---------------------------------------------------------------------------
echo ""
echo "Step 2: Installing dependencies..."
LOCK_HASH="$(md5sum package-lock.json | cut -d' ' -f1)"
STAMP="node_modules/.lock-hash"
if [ -d node_modules ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$LOCK_HASH" ]; then
  echo -e "${GREEN}   Unchanged since the last install; skipped${NC}"
else
  npm ci --no-audit --no-fund || fail "npm ci failed"
  echo "$LOCK_HASH" > "$STAMP"
  echo -e "${GREEN}   Dependencies installed${NC}"
fi

# ---------------------------------------------------------------------------
# Step 3: Type check (API and web)
# ---------------------------------------------------------------------------
echo ""
if [ "$TYPECHECK" = 1 ]; then
  echo "Step 3: Type check..."
  (cd api && npx tsc --noEmit) || fail "Type errors in the API (shown above)"
  (cd web && npx tsc --noEmit) || fail "Type errors in the web app (shown above)"
  echo -e "${GREEN}   No type errors${NC}"
else
  echo "Step 3: Type check... skipped (--skip-typecheck)"
fi

# ---------------------------------------------------------------------------
# Step 4: Build the web app beside the live one
#
# The build goes to web/dist-new, so the live web/dist keeps serving until the
# swap in step 6.
# ---------------------------------------------------------------------------
echo ""
echo "Step 4: Building the web app..."
rm -rf web/dist-new
(cd web && npx vite build --outDir dist-new --emptyOutDir) || fail "The web build failed"
[ -f web/dist-new/index.html ] || fail "The web build produced no index.html"
echo -e "${GREEN}   Built into web/dist-new${NC}"

# ---------------------------------------------------------------------------
# Step 5: Database migrations
#
# Applies every SQL file in api/src/migrations that the schema_migrations
# table does not list yet, each in its own transaction. This runs while the
# old code is still serving, so a migration has to work with the previous
# version too: add columns in one release, remove them in a later one.
# ---------------------------------------------------------------------------
echo ""
echo "Step 5: Applying database migrations..."
MIGRATE_OUT="$(npm run --silent migrate 2>&1)" || { echo "$MIGRATE_OUT"; fail "A database migration failed (it was rolled back; nothing was half-applied)"; }
if [ -n "$MIGRATE_OUT" ]; then echo "$MIGRATE_OUT" | sed 's/^/   /'; else echo "   Nothing new to apply"; fi
echo -e "${GREEN}   Database is up to date${NC}"

# ---------------------------------------------------------------------------
# Step 6: Swap
#
# File names in web/dist/assets contain a hash of their content. Someone with
# the site already open still asks for the previous build's files (the Studio
# and Admin chunks load on demand), so those are carried into the new build
# before it goes live. Then the directories are renamed, which is instant.
# ---------------------------------------------------------------------------
echo ""
echo "Step 6: Swapping the new build in..."
STAMP_TIME="$(date +%Y%m%d-%H%M%S)"
if [ -d web/dist ]; then
  if [ -d web/dist/assets ]; then cp -rn web/dist/assets/. web/dist-new/assets/ 2>/dev/null || true; fi
  mv web/dist "web/dist-backup-${STAMP_TIME}" || fail "Could not move the live build aside"
fi
if ! mv web/dist-new web/dist; then
  [ -d "web/dist-backup-${STAMP_TIME}" ] && mv "web/dist-backup-${STAMP_TIME}" web/dist
  fail "Could not move the new build into place; the previous build was put back"
fi
# Keep only the newest few backups.
ls -1d web/dist-backup-* 2>/dev/null | sort -r | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -rf "$old"; done
echo -e "${GREEN}   New web build is live${NC}"

# ---------------------------------------------------------------------------
# Step 7: Reload the API
#
# Rolling by default: the launcher replaces its processes one at a time and
# no request is dropped. A full restart (a few seconds of downtime) is used
# when asked for, or when the launcher or its PM2 settings changed.
# ---------------------------------------------------------------------------
echo ""
echo "Step 7: Reloading PM2..."
if ! pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 start scripts/deploy/ecosystem.config.cjs && pm2 save
  echo "   Started ${APP_NAME} for the first time"
elif [ "$RESTART" = 1 ] || ! git diff --quiet "$BEFORE" "$AFTER" -- scripts/deploy/ecosystem.config.cjs scripts/deploy/cluster.mjs; then
  pm2 restart scripts/deploy/ecosystem.config.cjs --update-env && pm2 save
  echo "   Full restart"
else
  pm2 sendSignal SIGHUP "$APP_NAME" >/dev/null
  echo "   Rolling reload requested"
fi

# ---------------------------------------------------------------------------
# Step 8: Health check
# ---------------------------------------------------------------------------
echo ""
echo "Step 8: Checking health..."
PORT="$(grep -E '^PORT=' .env | tail -n 1 | cut -d= -f2)"
PORT="${PORT:-4000}"
sleep 3
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done

ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "=================================="
if [ "$HEALTHY" = 1 ]; then
  echo -e "${GREEN}Deployed ${AFTER:0:9} in ${ELAPSED}s. The site is answering.${NC}"
  pm2 status "$APP_NAME" 2>/dev/null | sed -n '1,8p'
  exit 0
fi

echo -e "${RED}The API did not answer /api/health within 60 seconds.${NC}"
echo "Look at the log first:"
echo "   pm2 logs ${APP_NAME} --lines 80"
echo "To go back to the previous version:"
echo "   git checkout ${BEFORE} && ./build-and-swap.sh --no-pull --restart"
echo "(Database migrations are not reversed by going back.)"
exit 1
