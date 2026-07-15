---
title: CI tsc --noEmit type-checks tests/ too; stale tsbuildinfo can hide a real failure locally
category: build-errors
tags: [typescript, tsc, incremental, tsbuildinfo, jest, TS2556, ci]
severity: medium
date: 2026-07-15
source: auto — /work
applicable_to: project
---

## What Happened

PR #1236 (#1232) passed `bun run typecheck` locally but CI's `tsc --noEmit` failed with TS2556 on a jest mock in `tests/unit/agent-mint-client.test.ts` / `agent-mint-lambda-handler.test.ts`.

## Root Cause

- Root `tsconfig.json` `exclude` is only `["node_modules", "infra"]` — `tests/` is type-checked by `tsc --noEmit` same as app code. Easy to assume tests are excluded; they aren't.
- `tsconfig.json` has `"incremental": true`. A local `bun run typecheck` run can reuse a stale `.tsbuildinfo` and report success even after introducing a real type error, while CI always runs clean and fails. `rm` the tsbuildinfo file to force a full reproduction locally.
- Specific TS2556 cause: `const createGatewayMock = jest.fn(() => ({ gateway: true }))` gives the mock a no-arg (empty-tuple) parameter type. Code elsewhere spread captured args into it — `(...a) => createGatewayMock(...a)` — which TS rejects because the spread argument isn't assignable to an empty tuple.

## Solution

- Give the mock a rest param so its inferred signature accepts any args: `jest.fn((..._a: unknown[]) => ({ gateway: true }))`.
- To reproduce a CI-only typecheck failure locally, delete the incremental build cache first (find the `tsBuildInfoFile`/default `.tsbuildinfo` and remove it) before re-running `bun run typecheck`.

## Prevention

- Don't trust a passing local `bun run typecheck` after touching a test file if the working tree has stale build artifacts — clear incremental cache when a CI mismatch is suspected.
- When writing a `jest.fn()` mock that stands in for a function whose call site passes variable/spread args, default to a rest-param signature (`(..._a: unknown[]) => ...`) instead of a no-arg arrow, to avoid tuple-arity mismatches under strict TS.
