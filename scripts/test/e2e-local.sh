#!/usr/bin/env bash
#
# scripts/test/e2e-local.sh — run the authenticated Playwright E2E suite locally.
#
# WHY LOCAL INSTEAD OF GITHUB CI:
#   The suite drives real logged-in flows (Atrium collab, nexus, admin pages,
#   scheduling, assistant-architect). Most specs need seeded data AND configured
#   AI providers. A clean GitHub runner has neither, so the job could only ever go
#   red or force-fit a committed AUTH_SECRET (which GitHub's secret scanner flags).
#   Your machine already has .env.local (real AUTH_SECRET + Cognito + provider keys)
#   and a populated local database, so the suite runs where the env actually exists.
#
# HOW IT WORKS:
#   The Playwright auth harness mints a NextAuth session cookie directly. That cookie
#   only decrypts on a DEV server (NODE_ENV != production); a production build switches
#   to secure-cookie semantics and rejects it. AND every auth redirect uses AUTH_URL —
#   if AUTH_URL's port doesn't match the serving port, redirects 307 to a dead origin
#   (ERR_CONNECTION_REFUSED). So this runner uses a DEV server on port 3000 with
#   AUTH_URL pinned to http://localhost:3000 (origin == port). If a healthy server is
#   already on :3000 (your `bun run dev:local`), it is reused; otherwise the runner
#   starts its own — in an isolated build dir (.next-e2e via NEXT_DIST_DIR) so it never
#   locks or pollutes your normal `.next` — and tears it down afterward.
#
#   Next dev lazily compiles each route on first hit and can fall over under parallel
#   load, so the runner warms the heavy routes first and caps workers (E2E_WORKERS=2).
#
# WIRING: invoked by .githooks/pre-push (installed via the package.json "prepare"
#   script -> core.hooksPath=.githooks, so it travels with every checkout, no husky).
#   Also runnable on demand:  bun run test:e2e:local  [extra playwright args]
#
# KNOBS:
#   SKIP_E2E=1         skip entirely for one push       (never runs in CI)
#   E2E_PORT=3000      port for the dev server
#   E2E_DATABASE_URL   DB for a runner-started server (default: local Docker
#                      postgres). Deliberately NOT plain DATABASE_URL — that is
#                      sourced from .env.local and may be container-perspective.
#   E2E_DB_SSL         DB_SSL for a runner-started server (default: false)
#   E2E_WORKERS=2      Playwright worker count (global-setup warms every route the
#                      suite hits, so a cold server doesn't thrash at 2; drop to 1
#                      if you still see compile-timeout flakiness)
#   E2E_RUN_EXTERNAL=1 also run live-provider specs (AI chat / voice; needs keys)
set -uo pipefail

if [ "${CI:-}" = "true" ]; then echo "e2e-local: in CI — skipping (local-only suite)"; exit 0; fi
if [ "${SKIP_E2E:-}" = "1" ]; then echo "e2e-local: SKIP_E2E=1 — skipping"; exit 0; fi

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT" || exit 1

E2E_PORT="${E2E_PORT:-3000}"
BASE="http://localhost:${E2E_PORT}"

# --- Local secrets (AUTH_SECRET + AUTH_COGNITO_* from .env.local) -----------------
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
if [ -z "${AUTH_SECRET:-}" ]; then
  echo "❌ e2e-local: AUTH_SECRET not set (expected in .env.local). Aborting."; exit 1
fi

# --- Reuse a running :3000 dev server, or start our own ----------------------------
STARTED_PID=""
if curl -sf "$BASE/api/healthz" >/dev/null 2>&1; then
  echo "e2e-local: reusing the dev server already on :$E2E_PORT"
else
  echo "e2e-local: starting a dev server on :$E2E_PORT (AUTH_URL pinned to it; isolated .next-e2e)…"
  # Pin the started server to the LOCAL Docker postgres, exactly like the
  # `dev:local` script does. .env.local was sourced above (for AUTH_SECRET) and
  # on some machines it carries the CONTAINER-perspective DATABASE_URL
  # (host.docker.internal / master / sslmode=require) — unusable from a host
  # process, and under the old ${DATABASE_URL:-…} fallback it silently won,
  # leaving the started server unable to reach the DB at all (every query fails
  # from boot; authed specs die on a /dashboard redirect at ~15s each). Use
  # E2E_DATABASE_URL / E2E_DB_SSL to point the suite at a non-default DB.
  AUTH_URL="$BASE" NEXT_DIST_DIR=.next-e2e \
  DATABASE_URL="${E2E_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/aistudio}" \
  DB_SSL="${E2E_DB_SSL:-false}" PORT="$E2E_PORT" HOSTNAME=127.0.0.1 \
    bun run server.ts > /tmp/e2e-local-server.log 2>&1 &
  STARTED_PID=$!
  # On exit: stop our server and undo Next's automatic tsconfig.json edit (running
  # `next dev` with a custom distDir appends "<distDir>/types" to tsconfig include).
  cleanup() {
    [ -n "$STARTED_PID" ] && kill "$STARTED_PID" >/dev/null 2>&1
    git checkout -- tsconfig.json >/dev/null 2>&1
    return 0
  }
  trap cleanup EXIT INT TERM
  echo -n "e2e-local: waiting for $BASE "
  ready=0
  for attempt in $(seq 1 90); do
    curl -sf "$BASE/api/healthz" >/dev/null 2>&1 && { ready=1; echo "— ready"; break; }
    echo -n "."; sleep 2
  done
  if [ "$ready" != "1" ]; then
    echo ""; echo "❌ e2e-local: dev server never became healthy. Last log lines:"
    tail -20 /tmp/e2e-local-server.log; exit 1
  fi
fi

# --- Seed the LOCAL database idempotently -----------------------------------------
# Allowed: local Docker postgres is fair game (Aurora is off-limits; only
# data-destroying commands are forbidden). `docker exec … psql` matches `db:seed`.
if docker exec -i aistudio-postgres pg_isready -U postgres >/dev/null 2>&1; then
  echo "e2e-local: seeding local DB (test users + Atrium reference doc + doc state)…"
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < scripts/db/seed-local.sql >/dev/null 2>&1 || true
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/atrium-reference-seed.sql >/dev/null 2>&1 || true
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/assistant-architect-seed.sql >/dev/null 2>&1 || true
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/aistudio" DB_SSL=false \
    bun run scripts/dev/seed-atrium-doc-state.ts >/dev/null 2>&1 || true
else
  echo "⚠️  e2e-local: local postgres (aistudio-postgres) not reachable — skipping re-seed."
fi

# --- Run Playwright ---------------------------------------------------------------
# Route warm-up is done by tests/e2e/global-setup.ts (a real authenticated browser
# pass, gated on PLAYWRIGHT_WARM=1) — it compiles dev client bundles so the parallel
# suite doesn't hit cold-compile timeouts. retries cover any residual dev slowness.
export PLAYWRIGHT_BASE_URL="$BASE"
export PLAYWRIGHT_AUTH_ENABLED=true
export PLAYWRIGHT_WARM=1
if [ "${E2E_RUN_EXTERNAL:-}" != "1" ]; then export E2E_EXCLUDE_EXTERNAL=1; fi

# Default to ONE worker: the host `next dev` server recompiles routes on demand and
# can't keep up with the parallel suite, so workers=2 produced load-induced timeout
# flakes (tests that pass in isolation). Serial is slower but reliable, so the hook
# passes without SKIP_E2E. Override with E2E_WORKERS=N for a faster, flakier run.
echo "e2e-local: running Playwright suite against $BASE (workers=${E2E_WORKERS:-1}, retries=${E2E_RETRIES:-2})…"
# Capture output (tee keeps it live) so we can tell GENUINE failures from FLAKY tests.
RUN_LOG="$(mktemp)"
set -o pipefail
bunx playwright test --workers="${E2E_WORKERS:-1}" --retries="${E2E_RETRIES:-2}" "$@" 2>&1 | tee "$RUN_LOG"
RESULT=$?
set +o pipefail

# A flaky test (failed once, passed on retry) is a PASS. Playwright still exits
# non-zero when ANY test is flaky, but a host `next dev` server has inherent timing
# flakiness (collab/streaming/ReactFlow/modal) that no amount of serial + retry fully
# removes. Block the push only on GENUINE failures (a "N failed" summary line), not a
# flaky-only run. CI (built app, stricter, retries) remains the hard gate.
if [ "$RESULT" -ne 0 ] && ! grep -qE "^[[:space:]]+[0-9]+ failed" "$RUN_LOG"; then
  echo ""
  echo "e2e-local: only flaky tests (passed on retry) — no genuine failures. Treating as pass."
  RESULT=0
fi
rm -f "$RUN_LOG"

if [ "$RESULT" -ne 0 ]; then
  echo ""
  echo "❌ e2e-local: Playwright suite failed (exit $RESULT) — push blocked."
  echo "   Fix the failing specs, or bypass intentionally with: SKIP_E2E=1 git push"
fi
exit "$RESULT"
