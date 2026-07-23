---
title: CodeQL js/user-controlled-bypass — field-presence guards, cascading alerts, and dismissal workflow
category: security
tags:
  - codeql
  - false-positive
  - user-controlled-bypass
  - code-scanning-api
  - pr-review
  - capabilities-migration
  - rebase-conflict
  - concurrent-agents
severity: high
date: 2026-06-23
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1050 (hasToolAccess→hasCapabilityAccess migration) kept failing the CodeQL CI gate on a `js/user-controlled-bypass` high-severity alert in `actions/db/schedule-actions.ts`. A field-presence guard (`if (params.assistantArchitectId !== undefined)`) wrapping an authz check was flagged as a user-controlled security bypass. Removing a redundant inner `hasCapabilityAccess` call fixed alert #466 but CodeQL immediately raised a new instance (#467) at the next authz call in the same branch. Alert #467 was a false positive and had to be dismissed via the code-scanning API.

## Root Cause

Two compounding issues:

1. **Cascading CodeQL alerts**: CodeQL surfaces a pre-existing pattern as "new in PR" when the PR rewrites lines around it. Fixing one alert instance can expose the adjacent authz call in the same branch as a fresh instance. The repo had already dismissed this rule class (#380–#402) as false positives — field-presence partial-update guards are not security toggles.

2. **Concurrent agent push races**: Two review agents pushed overlapping fixes to the same PR branch mid-review, producing rebase conflicts across multiple files simultaneously.

## Solution

- **Alert #466 (real)**: Removed a genuinely redundant inner `hasCapabilityAccess` check — the outer `updateScheduleAction` already enforces it.
- **Alert #467 (false positive)**: Dismissed via GitHub code-scanning API:
  ```bash
  # 1. Find the open instance scoped to the PR merge ref
  gh api "repos/psd401/aistudio/code-scanning/alerts?ref=refs/pull/1050/merge&state=open&tool_name=CodeQL"

  # 2. PATCH to dismiss (dismissed_comment hard-capped at 280 chars)
  gh api repos/psd401/aistudio/code-scanning/alerts/{N} \
    -X PATCH \
    -f state=dismissed \
    -f dismissed_reason="false positive" \
    -f dismissed_comment="Field-presence guard (params.assistantArchitectId !== undefined) is a partial-update pattern, not a security toggle. Ownership check always runs when the field is present. Consistent with prior dismissals #380-402."
  ```
  The CodeQL CI gate refreshed within ~1 min of dismissal — no new commit needed.

- **Rebase conflicts**: Reset to upstream HEAD (`git fetch origin; git reset --hard origin/<branch>`) and re-applied only non-overlapping changes rather than resolving conflict markers across 5 files.

## Prevention

- When a PR touches authz-adjacent code, run `gh api "repos/.../code-scanning/alerts?ref=refs/pull/N/merge&state=open"` early to surface any pre-existing alerts that will block the gate.
- Query with `?ref=refs/pull/N/merge` not `?ref=refs/heads/branch-name` — the PR merge ref is what the check evaluates.
- Expect one fix to cascade: after dismissing or fixing one `js/user-controlled-bypass` instance, re-check immediately for a sibling instance at the next authz call in the same branch.
- Keep `dismissed_comment` under 280 chars — GitHub silently rejects longer strings.
- With concurrent review agents on the same branch, coordinate or expect reset-and-reapply rather than merge-conflict resolution.
- See also: `security/2026-02-20-codeql-taint-break-static-data-block.md` for the broader CodeQL false-positive dismissal pattern.
