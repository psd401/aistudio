---
title: Verify fixes are committed and pushed before concluding a PR review is stale
category: workflow
tags:
  - git
  - uncommitted-changes
  - pr-review
  - working-tree-vs-head
  - review-pr
  - stale-diff
  - commit-hygiene
severity: high
date: 2026-06-16
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1032 (unified tool catalog, #924) received a Round 2 review that re-flagged all 10 findings from Round 1. Investigation revealed the Round 1 fixes had been made in a prior session but were never committed or pushed — they sat in the working tree while the remote PR still carried the unfixed code. The reviewer evaluated the stale remote diff, not the local edits.

## Root Cause

A prior session edited files to address review findings but ended without committing. A subsequent session assumed the fixes were already in the remote because a "address review feedback" commit title existed — but that commit predated the actual edits. Remote HEAD and local working tree diverged silently.

## Solution

Run `git status` and `git diff HEAD` before drawing any conclusion about whether review findings are or aren't addressed. Reconcile three states: working tree, HEAD commit, and remote branch. All 10 findings were already correctly implemented locally; the only action needed was to commit and push. Verification: 26/26 jest tests pass, typecheck clean, eslint clean.

## Prevention

- Always run `git status` / `git diff HEAD` as the first step when a reviewer re-flags something you believe is fixed.
- Treat "commit titled 'address review feedback'" as insufficient proof — inspect the actual diff.
- End every session that touches PR files with an explicit commit + push, even if the work feels incremental.
- Never assume working-tree state matches remote state across session boundaries.
