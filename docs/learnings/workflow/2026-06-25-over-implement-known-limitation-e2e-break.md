---
title: Over-implementing a "document this" review finding breaks designed behavior
category: workflow
tags:
  - pr-review
  - over-engineering
  - known-limitation
  - e2e-flake
  - yjs-collab
  - open-redirect
  - jwt-ttl
  - env-var-parsing
  - drizzle-defaultRandom
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1062 (Atrium Phase 1 collab loop) Round 7 review included a LOW finding asking to
DOCUMENT a name-collision limitation in the agent-bridge X-Agent-Id header. Instead of
adding a comment/doc, an enforcement guard was added that rejected any X-Agent-Id that
matched a registered agent name rather than a UUID. The legitimate Phase-1 path — attributing
an edit by agent name because `agent_identities.id` is a `defaultRandom()` UUID unknowable at
call sites — was blocked. The authed E2E (agent-bridge test) 403'd.

## Root Cause

Conflating "document this limitation" with "enforce against this limitation." The finding
was scoped to observability/clarity, not security hardening. The new guard was not validated
against existing E2E seed fixtures before committing.

Secondary: a pre-push Playwright hook running a cold dev-server in parallel with E2E produced
4 failed / 4 flaky results that passed cleanly on a warm isolated re-run — misread as a
regression, wasting a debugging cycle.

## Solution

- Revert the name-collision enforcement guard; replace with a code comment documenting the
  known limitation (UUIDs are opaque at call sites, so name-based attribution is Phase-1
  design, not a bug).
- Isolate flaky Playwright failures: re-run individually on a warm server before treating as
  a real regression.

## Prevention

- When a review finding says "document this as a known limitation," add prose/comment only —
  do not add enforcement logic unless the finding explicitly asks for it.
- Before merging any new auth/validation gate, run `bunx playwright test` against the exact
  seed fixtures used in CI to catch 403s early.
- Treat pre-push hook Playwright failures as suspect until reproduced on a warm isolated run.
