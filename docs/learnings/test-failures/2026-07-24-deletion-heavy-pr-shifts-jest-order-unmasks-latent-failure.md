---
title: Deletion-heavy PRs can shift jest file execution order and unmask pre-existing failures
category: test-failures
tags:
  - jest
  - test-order
  - manifest-version
  - tool-catalog
  - deletion
severity: medium
date: 2026-07-24
source: auto — /work
applicable_to: project
---

## What Happened

While decommissioning scheduled-execution files (#1322/PR #1323), deleting scheduling
test files shifted jest's full-suite file execution order and exposed a failure in
`tests/unit/lib/tools/catalog.test.ts` ("get() surfaces is_active=false") that was
already broken on `dev` before this PR. Commit `b5383e96` had bumped the
`assistants.execute` entry in `TOOL_MANIFEST`
(`lib/tools/catalog/manifest.ts`) to `version: "v2"`, but the test's mock
`tool_catalog` row hardcoded `version: "v1"`. Since the DB-disable lookup key is
`identifier@version`, the mock row never matched `inactiveCodeKeys` and `isActive`
stayed `true` — the assertion was silently wrong, but full-suite ordering had masked
it until this PR's deletions changed which file ran first.

## Root Cause

Test isolation gap: a mock fixture hardcoded a manifest version instead of deriving it
from the manifest constant, so the two drifted independently. The failure was
order-dependent (only surfaced in certain full-suite run orders), so touched-file-only
test runs never caught it.

## Solution

Fixed in `a75f31e0`: derive the mock row's version from `TOOL_MANIFEST` at test time
instead of hardcoding it:
```ts
const assistantsExecuteVersion = TOOL_MANIFEST.find(
  (t) => t.identifier === "assistants.execute"
)!.version
```

## Prevention

- Run the full `bun run test:ci` locally (not just touched-file tests) before pushing
  a large-deletion PR — deletions can reorder the suite and surface latent,
  order-masked failures unrelated to the deletion itself.
- Mock rows keyed by `identifier@version` (or any composite key mirroring a manifest
  entry) should always derive the version from the manifest constant, never hardcode
  it — a future manifest version bump would otherwise silently re-orphan the row.
