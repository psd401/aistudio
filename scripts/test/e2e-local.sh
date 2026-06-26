#!/usr/bin/env bash
#
# scripts/test/e2e-local.sh — run the authenticated Playwright E2E suite locally.
#
# WHY LOCAL INSTEAD OF GITHUB CI:
#   The suite drives real, logged-in flows (Atrium collab, nexus conversations,
#   admin pages, scheduling, assistant-architect). Most specs need seeded data
#   AND configured AI providers. A clean GitHub runner has neither, so it can only
#   ever fail or require a hardcoded AUTH_SECRET committed to the repo (which
#   GitHub's secret scanner correctly flags). Your machine already has .env.local
#   (real AUTH_SECRET + Cognito + provider keys) and a populated local database —
#   so the suite runs where the environment actually exists.
#
# WIRING: invoked by .githooks/pre-push (installed via the package.json "prepare"
#   script, which points core.hooksPath at .githooks so it travels with every
#   checkout). Also runnable on demand: `bun run test:e2e:local`.
#
# ESCAPE HATCH: `SKIP_E2E=1 git push` skips it for one push. It never runs in CI.
#
# Pass extra Playwright args through, e.g.:
#   bun run test:e2e:local tests/e2e/atrium-phase1-verify.spec.ts
set -uo pipefail

if [ "${CI:-}" = "true" ]; then echo "e2e-local: in CI — skipping (this suite is local-only)"; exit 0; fi
if [ "${SKIP_E2E:-}" = "1" ]; then echo "e2e-local: SKIP_E2E=1 — skipping"; exit 0; fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# --- Load local secrets (AUTH_SECRET + AUTH_COGNITO_* live in .env.local) --------
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
if [ -z "${AUTH_SECRET:-}" ]; then
  echo "❌ e2e-local: AUTH_SECRET is not set (expected in .env.local)."
  echo "   The auth harness mints/verifies the session cookie with it. Aborting."
  exit 1
fi

# --- Find a running dev server, or start an ephemeral one ------------------------
# Next dev allows only ONE instance per checkout, so we reuse the dev server you
# already have running (the normal workflow); only if none responds do we start
# our own and tear it down afterward.
PORTS="${PLAYWRIGHT_PORTS:-3100 3000 3200}"
BASE=""
for p in $PORTS; do
  if curl -sf "http://localhost:$p/api/healthz" >/dev/null 2>&1; then BASE="http://localhost:$p"; break; fi
done

STARTED_PID=""
if [ -z "$BASE" ]; then
  PORT="${E2E_PORT:-3100}"
  echo "e2e-local: no dev server detected on [$PORTS]; starting one on :$PORT"
  echo "           (first run lazily compiles routes — expect this to be slower)…"
  DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/aistudio}" \
  DB_SSL="${DB_SSL:-false}" PORT="$PORT" HOSTNAME=127.0.0.1 \
    bun run server.ts > /tmp/e2e-local-server.log 2>&1 &
  STARTED_PID=$!
  BASE="http://localhost:$PORT"
  echo -n "e2e-local: waiting for $BASE "
  for _ in $(seq 1 90); do
    curl -sf "$BASE/api/healthz" >/dev/null 2>&1 && { echo "— ready"; break; }
    echo -n "."; sleep 2
  done
fi
echo "e2e-local: target → $BASE"

# --- Seed the LOCAL database idempotently ----------------------------------------
# Allowed: the local Docker postgres is fair game (only Aurora is off-limits, and
# only data-destroying commands are forbidden). `docker exec … psql` is the same
# mechanism `bun run db:seed` already uses — it is NOT a container-lifecycle op.
if docker exec -i aistudio-postgres pg_isready -U postgres >/dev/null 2>&1; then
  echo "e2e-local: seeding local DB (test users + Atrium reference doc + doc state)…"
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < scripts/db/seed-local.sql >/dev/null 2>&1 || true
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/atrium-reference-seed.sql >/dev/null 2>&1 || true
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/aistudio" DB_SSL=false \
    bun run scripts/dev/seed-atrium-doc-state.ts >/dev/null 2>&1 || true
else
  echo "⚠️  e2e-local: local postgres (aistudio-postgres) not reachable — skipping re-seed."
fi

# --- Run Playwright --------------------------------------------------------------
# External-provider specs (live AI chat / voice) only run when explicitly enabled
# with provider keys present (E2E_RUN_EXTERNAL=1); otherwise they're excluded.
export PLAYWRIGHT_BASE_URL="$BASE"
export PLAYWRIGHT_AUTH_ENABLED=true
if [ "${E2E_RUN_EXTERNAL:-}" != "1" ]; then export E2E_EXCLUDE_EXTERNAL=1; fi

echo "e2e-local: running Playwright suite…"
bunx playwright test "$@"
RESULT=$?

# --- Teardown (only a server WE started) -----------------------------------------
if [ -n "$STARTED_PID" ]; then kill "$STARTED_PID" >/dev/null 2>&1 || true; fi

if [ "$RESULT" -ne 0 ]; then
  echo ""
  echo "❌ e2e-local: Playwright suite failed (exit $RESULT) — push blocked."
  echo "   Fix the failing specs, or bypass intentionally with: SKIP_E2E=1 git push"
fi
exit "$RESULT"
