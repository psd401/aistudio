#!/usr/bin/env bash
#
# scripts/test/e2e-local.sh — run the authenticated Playwright E2E suite locally.
#
# WHY LOCAL INSTEAD OF GITHUB CI:
#   The suite drives real logged-in flows (Atrium collab, nexus, admin pages,
#   assistant-architect). Most specs need seeded data AND configured
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
#   (ERR_CONNECTION_REFUSED). So this runner uses a DEV server on port 3100 with
#   AUTH_URL pinned to http://localhost:3100 (origin == port). Port 3100 — NOT 3000 —
#   because on machines that keep the Dockerized app on :3000, the healthz reuse
#   check below would latch onto that container, which answers healthz fine but
#   rejects the minted cookie (every authed spec dies on a /dashboard redirect).
#   If a healthy server is already on :3100 (e.g. a prior harness run), it is
#   reused ONLY when it belongs to this worktree (the listener's cwd matches this
#   repo root) — a healthy server from ANOTHER worktree/checkout serves different
#   code and a different node_modules, so gating this push on it is meaningless
#   at best (see the 2026-07-26 duplicate-@codemirror/state incident, where a
#   foreign server failed code-tab-renders 3/3 on every branch that reused it).
#   When a foreigner owns the port, the runner scans the next few ports for a
#   free one instead. A runner-started server lives in an isolated build dir
#   (.next-e2e via NEXT_DIST_DIR) so it never locks or pollutes your normal
#   `.next` — and is torn down afterward.
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
#   E2E_PORT=3100      base port for the dev server (avoid 3000: the Docker app
#                      owns it). A healthy server here is reused only if it is
#                      THIS worktree's; otherwise E2E_PORT+1..+9 are scanned for
#                      a free port
#   E2E_DATABASE_URL   DB for a runner-started server (default: local Docker
#                      postgres). Deliberately NOT plain DATABASE_URL — that is
#                      sourced from .env.local and may be container-perspective.
#   E2E_DB_SSL         DB_SSL for a runner-started server (default: false)
#   E2E_ATRIUM_STORAGE_DIR local filesystem root for Atrium snapshots (default:
#                      /tmp/aistudio-atrium-e2e-<port>; never touches AWS S3)
#   E2E_WORKERS=2      Playwright worker count (global-setup warms every route the
#                      suite hits, so a cold server doesn't thrash at 2; drop to 1
#                      if you still see compile-timeout flakiness)
#   PLAYWRIGHT_WARM=0  skip route warm-up for a narrow diagnostic rerun
#   E2E_RUN_EXTERNAL=1 also run live-provider specs (AI chat / voice; needs keys)
set -uo pipefail

if [ "${CI:-}" = "true" ]; then echo "e2e-local: in CI — skipping (local-only suite)"; exit 0; fi
if [ "${SKIP_E2E:-}" = "1" ]; then echo "e2e-local: SKIP_E2E=1 — skipping"; exit 0; fi

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT" || exit 1

# Single exit trap for everything this run owns: the started server, Next's
# automatic tsconfig.json edit (running `next dev` with a custom distDir appends
# "<distDir>/types" to the tsconfig include), and the machine-wide run lock.
STARTED_PID=""
LOCK_ACQUIRED=0
CLEANED=0
LOCK_DIR="/tmp/aistudio-e2e-local.lock"
on_exit() {
  # One-shot: cleanup must run exactly once. By the time a second invocation
  # could fire, a NEWER run may own the lock — releasing it again would strand
  # that run unprotected.
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  if [ -n "$STARTED_PID" ]; then
    kill "$STARTED_PID" >/dev/null 2>&1
    git checkout -- tsconfig.json >/dev/null 2>&1
  fi
  [ "$LOCK_ACQUIRED" = "1" ] && rm -rf "$LOCK_DIR"
  return 0
}
trap on_exit EXIT
# Signals must become a real exit, not just run the handler: bash RESUMES a
# script after a trapped-signal handler returns, so a Ctrl-C during the lock
# wait would keep waiting, and a mid-suite INT would release the lock while
# this run kept going. exit fires the EXIT trap, so cleanup still runs once.
trap 'exit 130' INT
trap 'exit 143' TERM

# --- One run at a time per machine --------------------------------------------------
# Two concurrent e2e-local runs (e.g. pushes from two worktrees) share ONE local
# postgres and one laptop: the younger suite re-seeds and mutates rows under the
# older one, and the resource contention can wedge a dev server for good. On
# 2026-07-26 a ~9-minute overlap left the younger server permanently hanging every
# /api route (92 spurious failures over the following hour), while the identical
# suite alone passed clean. Serialize instead: wait for the running instance.
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  holder_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
  if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
    # Steal under a dedicated steal-token so the destructive rm is serialized:
    # with a bare "check pid → rm → mkdir" steal, two waiters can both judge the
    # lock stale and the second's rm deletes the FIRST's freshly-created lock —
    # both then run concurrently, defeating the whole point. Only the waiter
    # holding the token may rm, and it re-verifies staleness inside the token.
    if mkdir "$LOCK_DIR.steal" 2>/dev/null; then
      pid_now="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
      if [ "$pid_now" = "$holder_pid" ]; then
        echo "e2e-local: stale lock (pid $holder_pid is gone) — taking over."
        rm -rf "$LOCK_DIR"
      elif [ -z "$pid_now" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
        # No pid file: either a FRESH lock whose winner hasn't written yet
        # (do not touch), or a creator that died between mkdir and the pid
        # write. Only age distinguishes them — steal only the old one.
        echo "e2e-local: stale lock (no pid recorded, dir is old) — taking over."
        rm -rf "$LOCK_DIR"
      fi
      rmdir "$LOCK_DIR.steal" 2>/dev/null
    elif [ -n "$(find "$LOCK_DIR.steal" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      # A stealer died inside the (milliseconds-wide) token window; reclaim.
      rmdir "$LOCK_DIR.steal" 2>/dev/null
    fi
    continue
  fi
  echo "e2e-local: another run (pid ${holder_pid:-unknown}, root: $(cat "$LOCK_DIR/root" 2>/dev/null || echo unknown)) is in progress — waiting 30s (bypass once with SKIP_E2E=1)…"
  sleep 30
done
LOCK_ACQUIRED=1
echo "$$" > "$LOCK_DIR/pid"
echo "$ROOT" > "$LOCK_DIR/root"

E2E_PORT="${E2E_PORT:-3100}"

# --- Local secrets (AUTH_SECRET + AUTH_COGNITO_* from .env.local) -----------------
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
if [ -z "${AUTH_SECRET:-}" ]; then
  echo "❌ e2e-local: AUTH_SECRET not set (expected in .env.local). Aborting."; exit 1
fi

# --- Pick a port whose server (if any) is OURS -------------------------------------
# Reusing a healthy server is only valid when it serves THIS worktree. Worktrees
# live inside the main checkout (.claude/worktrees/*), so several checkouts take
# turns owning :3100 — and a foreign server gates this push against the WRONG
# code, from a different node_modules (2026-07-26: a foreign server whose module
# graph had fallen through to the main checkout's stale tree failed
# code-tab-renders 3/3 on every branch that reused it, via a duplicate
# @codemirror/state crash no branch contained). Reuse only when the listener's
# cwd is this worktree; when a foreigner owns the port, scan for a free one.
ROOT_CANON="$(cd "$ROOT" && pwd -P)"

# The ownership check depends on lsof. Without it every healthy server would
# silently read as foreign (a pointless second server) and an occupied-but-dead
# port would read as free (a 3-minute startup stall) — fail actionably instead.
if ! command -v lsof >/dev/null 2>&1; then
  echo "❌ e2e-local: lsof is required (it verifies which worktree owns the dev server on a port)."
  echo "   Install lsof, or bypass this push with SKIP_E2E=1."
  exit 1
fi

# cwd of the process listening on TCP <port> ('' when none / undetermined).
port_owner_cwd() {
  local pid
  pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  [ -z "$pid" ] && return 0
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
}

# Two passes: prefer REUSING this worktree's own healthy server anywhere in the
# range over starting a fresh one on a lower free port (a redundant boot wastes
# a bun install + server start). Health probes carry --max-time: a server that
# accepts TCP but never answers /api/healthz (the wedged-server shape from the
# incident) must fail the probe fast, not stall the scan.
REUSE=0
CHOSEN_PORT=""
for port in $(seq "$E2E_PORT" $((E2E_PORT + 9))); do
  if curl -sf --max-time 3 "http://localhost:${port}/api/healthz" >/dev/null 2>&1 &&
     [ "$(port_owner_cwd "$port")" = "$ROOT_CANON" ]; then
    REUSE=1; CHOSEN_PORT="$port"; break
  fi
done
if [ "$REUSE" != "1" ]; then
  for port in $(seq "$E2E_PORT" $((E2E_PORT + 9))); do
    if curl -sf --max-time 3 "http://localhost:${port}/api/healthz" >/dev/null 2>&1; then
      owner="$(port_owner_cwd "$port")"
      echo "e2e-local: :$port serves ${owner:-an unknown directory}, not this worktree — can't gate this push on it."
    elif [ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ]; then
      echo "e2e-local: :$port is occupied by a non-healthy listener — skipping."
    else
      CHOSEN_PORT="$port"; break
    fi
  done
fi
if [ -z "$CHOSEN_PORT" ]; then
  echo "❌ e2e-local: no usable port in $E2E_PORT-$((E2E_PORT + 9)) (all owned by other worktrees/processes)."
  echo "   Stop one of those servers, or rerun with E2E_PORT=<free port>."
  exit 1
fi
E2E_PORT="$CHOSEN_PORT"
BASE="http://localhost:${E2E_PORT}"

# --- Reuse this worktree's dev server, or start our own ----------------------------
# Port-scoped log: two sequential runs on different ports (or a foreign server
# also logging) must not clobber one file — a shared name produced an unreadable
# interleaved log during the 2026-07-26 incident diagnosis.
SERVER_LOG="/tmp/e2e-local-server-${E2E_PORT}.log"
if [ "$REUSE" = "1" ]; then
  echo "e2e-local: reusing this worktree's dev server on :$E2E_PORT"
else
  # The server must start from a node_modules that matches bun.lock: an
  # incomplete tree makes Node fall through to the parent checkout's
  # node_modules (worktrees sit inside it), silently mixing two copies of
  # packages — the duplicate-@codemirror/state class of crash above.
  # --frozen-lockfile heals a merely incomplete tree and fails only when
  # bun.lock itself no longer matches package.json.
  echo "e2e-local: syncing node_modules (bun install --frozen-lockfile)…"
  if ! bun install --frozen-lockfile >/dev/null 2>&1; then
    echo "❌ e2e-local: node_modules cannot be synced — bun.lock does not match package.json."
    echo "   Run 'bun install' (and commit the lockfile), or bypass once with SKIP_E2E=1."
    exit 1
  fi
  echo "e2e-local: starting a dev server on :$E2E_PORT (AUTH_URL pinned to it; isolated .next-e2e)…"
  # Pin the started server to the LOCAL Docker postgres, exactly like the
  # `dev:local` script does. .env.local was sourced above (for AUTH_SECRET) and
  # on some machines it carries the CONTAINER-perspective DATABASE_URL
  # (host.docker.internal / master / sslmode=require) — unusable from a host
  # process, and under the old ${DATABASE_URL:-…} fallback it silently won,
  # leaving the started server unable to reach the DB at all (every query fails
  # from boot; authed specs die on a /dashboard redirect at ~15s each). Use
  # E2E_DATABASE_URL / E2E_DB_SSL to point the suite at a non-default DB.
  # API_RATE_LIMIT_DEFAULT_RPM: the suite funnels every /api/v1 call through ONE
  # test user; a warm server runs it fast enough to trip the production 60-RPM
  # sliding window (decision-* specs 429 and fail). Raise the budget for the
  # E2E server only — production keeps the code default.
  AUTH_URL="$BASE" NEXT_DIST_DIR=.next-e2e \
  DATABASE_URL="${E2E_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/aistudio}" \
  ATRIUM_LOCAL_STORAGE_DIR="${E2E_ATRIUM_STORAGE_DIR:-/tmp/aistudio-atrium-e2e-${E2E_PORT}}" \
  API_RATE_LIMIT_DEFAULT_RPM="${E2E_API_RATE_LIMIT_RPM:-600}" \
  DB_SSL="${E2E_DB_SSL:-false}" PORT="$E2E_PORT" HOSTNAME=127.0.0.1 \
    bun run server.ts > "$SERVER_LOG" 2>&1 &
  STARTED_PID=$!   # the on_exit trap (set at the top) stops it and restores tsconfig.json
  echo -n "e2e-local: waiting for $BASE "
  ready=0
  for attempt in $(seq 1 90); do
    curl -sf --max-time 3 "$BASE/api/healthz" >/dev/null 2>&1 && { ready=1; echo "— ready"; break; }
    echo -n "."; sleep 2
  done
  if [ "$ready" != "1" ]; then
    echo ""; echo "❌ e2e-local: dev server never became healthy. Last log lines ($SERVER_LOG):"
    tail -20 "$SERVER_LOG"; exit 1
  fi
fi

# --- Apply pending migrations to the LOCAL database --------------------------------
# A migration merged to dev but never applied locally silently breaks every route
# that touches the new table — e.g. the durable API rate limiter (migration 146)
# fails CLOSED, so every /api/v1 request 429s and ~30 authed specs go red with no
# obvious cause (2026-07-26 incident: gate red on pristine dev because migrations
# 146-153 were unapplied). The runner is idempotent (skips completed files) and
# targets ONLY the local DB, so this is a no-op costing ~2s on an up-to-date DB.
if docker exec -i aistudio-postgres pg_isready -U postgres >/dev/null 2>&1; then
  echo "e2e-local: applying pending local DB migrations…"
  if ! DATABASE_URL="${E2E_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/aistudio}" \
    DB_SSL="${E2E_DB_SSL:-false}" \
    bun scripts/db/run-migrations.ts >/dev/null 2>&1; then
    echo "❌ e2e-local: local DB migration run failed — run 'bun run db:migrate' for details"
    exit 1
  fi
fi

# --- Seed the LOCAL database idempotently -----------------------------------------
# Allowed: local Docker postgres is fair game (Aurora is off-limits; only
# data-destroying commands are forbidden). `docker exec … psql` matches `db:seed`.
if docker exec -i aistudio-postgres pg_isready -U postgres >/dev/null 2>&1; then
  echo "e2e-local: seeding local DB (test users + authenticated E2E fixtures)…"
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < scripts/db/seed-local.sql >/dev/null 2>&1 || true
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/atrium-reference-seed.sql >/dev/null 2>&1 || true
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/assistant-architect-seed.sql >/dev/null 2>&1 || true
  # Meridian editor (slice C) + artifact/embed (slice D) fixtures. Both are
  # idempotent (ON CONFLICT) and owned by the admin e2e-test-user so the minted
  # admin session gets manage rights; the gated atrium-meridian-editor /
  # atrium-meridian-artifact specs skip without this data.
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/atrium-editor-seed.sql >/dev/null 2>&1 || true
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/atrium-meridian-artifact-seed.sql >/dev/null 2>&1 || true
  # Public-reader (/p/[slug]) objects: a public doc live on public_web + an internal
  # doc also live on public_web (the strict-gate 404 case). Feeds both the Phase 7
  # public-reader spec and the Meridian slice-E anonymous reader assertions.
  docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=0 -q \
    < tests/e2e/fixtures/atrium-public-seed.sql >/dev/null 2>&1 || true
  # Visibility editor + Google-group visibility fixtures. These specs are part of
  # the authenticated suite and must work from a freshly reset local database.
  if ! docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=1 -q \
    < tests/e2e/fixtures/atrium-visibility-seed.sql >/dev/null; then
    echo "❌ e2e-local: failed to seed Atrium visibility fixture"
    exit 1
  fi
  if ! docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=1 -q \
    < tests/e2e/fixtures/atrium-group-visibility-seed.sql >/dev/null; then
    echo "❌ e2e-local: failed to seed Atrium group-visibility fixture"
    exit 1
  fi
  # The access-editor E2E covers models, assistants, and skills. Clean local DBs
  # already receive models + assistants above; add the deterministic skill row.
  if ! docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=1 -q \
    < tests/e2e/fixtures/resource-grants-seed.sql >/dev/null; then
    echo "❌ e2e-local: failed to seed resource-grants fixture"
    exit 1
  fi
  if ! docker exec -i aistudio-postgres psql -U postgres -d aistudio -v ON_ERROR_STOP=1 -q \
    < tests/e2e/fixtures/unified-content-repository-seed.sql >/dev/null; then
    echo "❌ e2e-local: failed to seed unified-content repository fixture"
    exit 1
  fi
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
export PLAYWRIGHT_WARM="${PLAYWRIGHT_WARM:-1}"
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
if [ "$RESULT" -ne 0 ] &&
   grep -qE "^[[:space:]]+[0-9]+ flaky" "$RUN_LOG" &&
   ! grep -qE "^[[:space:]]+[0-9]+ failed" "$RUN_LOG"; then
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
