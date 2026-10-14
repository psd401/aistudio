---
title: A client must render the server's computed verdict, not re-decide it against its own copy of the threshold
category: architecture
tags: [agent-schedules, cross-deploy-unit, duplication, verdict]
severity: medium
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

`lib/agent-schedules/service.ts` computes a `failing` verdict for a schedule
against a threshold (streak count). The `psd-schedules` skill — which runs
inside the agent container image, a separate deploy unit from the Next.js
app — discarded that `failing` field and re-decided the same verdict against
its own hardcoded copy of the threshold number.

## Root Cause

Two independent implementations of the same decision, one of them a client
of the other's output. As long as both constants agreed, this was invisible;
on drift (either value changed in one place during a later edit), the skill
would silently show a different `failing` status than the server computed,
with no error or warning — a classic constant-duplication-across-deploy-units
problem (see also [[schedule-audit-cadence-words-and-dual-validator-sync]]
for the same class of issue with cron validators).

## Solution

- The `psd-schedules list` skill now renders the server's `failing` field
  directly instead of recomputing it.
- Where a constant genuinely cannot be shared across deploy units (Lambda
  bundle / Next.js app / agent container image each build independently),
  pin it with a cross-importing test:
  `tests/unit/agent-schedule-failing-threshold.test.ts` imports the
  threshold from both locations (root jest can import from
  `infra/lambdas/...` by relative path) and asserts equality, so drift
  fails CI instead of failing silently in production.

## Prevention

- A client consuming a computed decision from a server/service should
  render that decision, not reconstruct it from raw inputs it also happens
  to have — reconstruction reintroduces the duplication the server call was
  supposed to eliminate.
- When a constant must exist in more than one deploy unit because there is
  no shared module path, add a test that imports both copies and asserts
  equality, so the two can't silently drift apart.
