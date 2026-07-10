---
title: Handling APPROVED reviews with Phase N follow-ups — do cheap forward-compatible fixes now
category: workflow
tags:
  - review-pr
  - incremental-review
  - atrium
  - api-scopes
  - visibility
  - unit-tests
  - phasing
severity: medium
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

Round 11 incremental review of PR #1061 (Atrium Phase 0). The only new feedback was a single
automated 'claude' review that was APPROVED. It listed 6 findings framed as "Phase N follow-ups"
on code paths that did not yet exist.

## Root Cause

When an approved reviewer flags future-phase work, there is a temptation to either (a) close all
items as out-of-scope or (b) open new issues for every finding. Neither is right. Some items are
cheap and forward-compatible enough to address in the current PR without expanding scope.

## Solution

Split findings by cost/scope:

- **Do now** (cheap, no new code paths):
  - Reserve an API scope (`content:read`) ahead of Phase 5 endpoints
  - Add "not dead code" comments to `update()` method used by future callers
  - Add rollback unit tests for an untested-but-shipping method (6 cases: existence-masking
    404 vs 403, wrong-object target, concurrent-delete)
  - Fix trailing newline in `.env.example`
  - Remove redundant `ListFilter` re-export

- **Document as follow-up** (genuinely future):
  - Re-derive jobs, REST endpoints — leave in issue/PR description, not a new issue

## Prevention

- When an approved review has "Phase N" findings, do a quick cost scan: anything fixable in
  < 30 min with no new code paths should land in the current PR.
- A two-implementation visibility predicate (SQL `listVisible` + JS `canView`) MUST have an
  explicit **"MUST mirror, edit both"** comment. Mocked unit tests cannot catch a SQL-only
  divergence — only the comment enforces the contract until integration tests exist.
- Never create a GitHub issue for in-scope work that can be fixed directly (see [[feedback_no_unnecessary_issues]]).
