---
title: Tests under infra/lambdas/*/__tests__/ gate nothing — no CI workflow invokes infra's jest `lambdas` project
category: workflow
tags:
  - ci-gate
  - jest
  - infra-lambdas
  - unified-content-processor
  - test-coverage
  - typecheck
severity: medium
date: 2026-08-01
source: auto — /lfg (issue #1525, PR #1532)
applicable_to: project
---

## What Happened

PR #1532 added `infra/lambdas/unified-content-processor/__tests__/contract.test.ts`
and `lifecycle.test.ts` (378 lines of coverage for the new sanitization and
terminal-classification logic). They pass locally and are invoked by **zero**
CI workflows — they do not gate the merge.

This extends
`docs/learnings/workflow/2026-07-05-infra-agent-image-excluded-from-root-gates-plus-sandbox-network-block.md`
(same "infra/ is outside the root gate" fact) to the `infra/lambdas/**` jest
suites specifically, where the gap is *narrower and less obvious* — infra does
have a jest project for these, it just never runs.

## Root Cause

Three configs have to line up, and they don't:

1. **Root jest excludes infra except one carve-out** (`jest.config.js:60`):
   ```js
   testPathIgnorePatterns: [ …, '/infra/(?!lambdas/agent-triage-poll/__tests__/)', … ]
   ```
   So `agent-triage-poll` runs under the root `bun run test:ci` gate; every
   other lambda's `__tests__/` is ignored.
2. **`infra/jest.config.js` *does* define a `lambdas` project**
   (`roots: ['<rootDir>/lambdas']`, `testMatch: ['**/__tests__/**/*.test.ts']`)
   — which is only reachable via `cd infra && bun run test`.
3. **No workflow runs `cd infra && bun run test`.** The `cdk-validate` job runs
   `cd infra && bun run build`, and infra's `build` script is
   `tsc && bun run typecheck:unified-content && bun run test:lambdas` — where
   `test:lambdas` is `cd lambdas/agent-skill-builder && bun install && bun run test`,
   i.e. one unrelated lambda's `bun:test` suite. `bun run test` (jest) is never
   called by anything.

Silver lining, and worth knowing: CI *does* typecheck this lambda's source, via
`typecheck:unified-content` → `tsc --project lambdas/unified-content-processor/tsconfig.json`
inside the same `cdk-validate` job. Type regressions are caught; behavioural
ones are not.

## Solution

For this PR, coverage of the shared sanitizer was deliberately placed in
`lib/utils/__tests__/text-sanitizer.test.ts` — under `lib/`, which the root jest
gate *does* run — so the load-bearing character-class and idempotency assertions
actually block a merge. The lambda-local tests remain as documentation and
local-run value.

## Prevention

- Before writing tests under `infra/lambdas/<name>/__tests__/`, check whether
  `<name>` is the `agent-triage-poll` carve-out in `jest.config.js`. If not, the
  suite is advisory only.
- Put the assertions that must gate merges in code that lives under a gated root
  (`lib/`, `app/`, `actions/`). Where a lambda imports shared code from `lib/`
  — as `unified-content-processor` imports `lib/utils/text-sanitizer` — test the
  shared module, not the lambda wrapper.
- If lambda-local behaviour genuinely must be gated, the fix is one line in
  `.github/workflows/ci.yml` (`cd infra && bun run test`) or extending infra's
  `build` script — but do it deliberately and confirm the `lambdas` project
  actually passes in a clean CI checkout first.
- Never report "tests pass" as merge confidence without confirming *which gate*
  runs them.
