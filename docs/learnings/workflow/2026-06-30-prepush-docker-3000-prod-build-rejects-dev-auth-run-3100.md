---
title: Pre-push hook's reused :3000 server is a prod Docker build that rejects dev auth cookies
category: workflow
tags: [e2e, pre-push, playwright, docker, auth, testing]
severity: medium
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083's authed E2E suite failed when the pre-push hook
(`.githooks/pre-push` → `scripts/test/e2e-local.sh`) reused an already-healthy
`:3000` server. That server is the Docker prod build, which rejects the
host-minted dev auth cookie used by the authenticated E2E harness.

## Root Cause

`scripts/test/e2e-local.sh` reuses any healthy server already listening on
`:3000` to save time. If that server is the Docker container (prod build)
rather than a host dev server, cookies minted by
`tests/e2e/helpers/session-auth.ts` for dev auth are rejected — the container
was never told about the shared `AUTH_SECRET` the same way a host dev server
is (see `docs/guides/e2e-authenticated-testing.md`).

## Solution

Run the authed E2E suite against a HOST dev server on `:3100` instead of
relying on the reused `:3000` container. Validated 18/18 for
nexus/organization suites this way. Then push with `SKIP_E2E=1` since the
pre-push hook's own `:3000` path isn't usable for authed tests in this setup.

## Prevention

Before relying on the pre-push hook's E2E run for authed specs, confirm
whether `:3000` is currently serving the Docker prod build or a host dev
server. If Docker, stand up a host dev server on `:3100` per
`docs/guides/e2e-authenticated-testing.md` and run the authed suite there
directly, then `SKIP_E2E=1` on push.
