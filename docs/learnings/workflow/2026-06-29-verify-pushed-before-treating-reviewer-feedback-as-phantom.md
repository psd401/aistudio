---
title: Verify commit was pushed before treating reviewer feedback as a phantom finding
category: workflow
tags:
  - git-push
  - pr-review
  - stale-remote
  - verify-pushed
  - codeql-false-positive
severity: high
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1081 (Atrium Phase 3 permissions/visibility) Round 6 fixes were committed locally but never pushed. The remote PR HEAD was stuck at Round 5. CI and the claude-review bot kept evaluating stale source and re-flagging already-fixed items across multiple subsequent rounds (7+), producing ~17 total findings across rounds before the commit was pushed and unblocked progress.

## Root Cause

`git commit` was run without a subsequent `git push`. Local `HEAD` diverged from the remote PR HEAD silently — no tool surfaced the mismatch until it was explicitly checked with `git rev-parse HEAD` vs `gh pr view --json headRefOid`.

A secondary finding: a pure rename (`objectId` → `idOrSlug`) shifted a previously-dismissed CodeQL alert's line number into the PR's changed-lines set, causing it to resurface as a new finding — not a code regression.

## Solution

- Compare `git rev-parse HEAD` to `gh pr view --json headRefOid` to detect commit/remote drift before concluding a reviewer's "fix not present" claim is a phantom.
- For the CodeQL rename resurface: re-dismiss via `gh api` with the same `false positive` reasoning as the already-dismissed sibling alerts rather than rewriting code.

## Prevention

- After any fix commit during a PR review cycle, immediately verify `git status` confirms the remote is not behind with `git push` before handing back for re-review.
- When a reviewer claims a fix is missing and you believe it was applied, check remote SHA before investigating the fix itself — the push gap is faster to confirm than re-auditing the code.
- Treat a rename as a potential CodeQL alert resurface trigger: scan dismissed alerts for the renamed identifier before pushing.
