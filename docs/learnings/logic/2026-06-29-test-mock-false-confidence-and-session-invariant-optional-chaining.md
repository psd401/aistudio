---
title: Mocked service calls silently document false-safe behaviour; optional chaining defeats session invariants
category: logic
tags:
  - atrium
  - permissions
  - visibility
  - jsdoc-drift
  - test-mock-false-confidence
  - session-invariant
  - single-source-of-truth
  - code-review
severity: high
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1081 (Atrium Phase 3 permissions/visibility) had JSDoc and test comments on
`setLevelInTx` and its action-level unit test both describing the behaviour as
"clears/ignores grants for non-group level". The real service threw a
`ValidationError` in that path. The action test mocked the entire service method,
so the mock absorbed the call silently and gave the test a passing result — the
comment drift went unnoticed across multiple review rounds.

A second finding: downstream code used `session?.sub` (optional chaining) after a
guard that already throws when `session` is null, causing `hasCapabilityAccess` to
re-call `getServerSession()` on `undefined` and silently defeat the same-session
invariant.

## Root Cause

1. **Mock absorbs the call the real code rejects.** When an action test fully
   mocks a service method, the test proves the action _calls_ the service but
   cannot prove the service _accepts_ the call. If the comment documents what the
   real service does (throws), but the mock absorbs without throwing, the test
   appears to validate a code path that would fail in production.

2. **Optional chaining on a guaranteed-non-null value.** `session?.sub` after
   `if (!session) throw` looks harmless but passes `undefined` to any downstream
   fn that re-resolves it — breaking the same-session guarantee and making the
   invariant invisible at the call site.

## Solution

- Corrected JSDoc and test comments to match the actual throw behaviour in
  `setLevelInTx`.
- Changed `session?.sub` → `session!.sub` with an explicit invariant comment so
  the non-null guarantee is visible and the compiler enforces it.
- Exported `GRANT_KIND_SET` and `assertLevel` from `validators.ts` as a single
  source of truth (previously duplicated across two typed definitions and left
  action-local).
- Widened `publish-document` input type to accept all `VisibilityLevel`s with
  runtime `assertLevel` narrowing instead of compile-time `"group"` literal.

## Prevention

- When writing action-level unit tests that fully mock a service: add a paired
  _service-level_ test for the same code path, or ensure the test comment
  references the service test file where the real behaviour is validated.
- After writing a test comment that describes what a dependency does, ask: "Would
  this test catch it if that description became wrong?" If the answer is no,
  the comment is documentation debt.
- Prefer `value!` over `value?.` immediately after a guard that throws — it keeps
  non-null invariants visible and catches drift when the guard is later weakened.
- Export shared validator sets/fns from a single `validators.ts` rather than
  duplicating `Set` literals across service and action files.
