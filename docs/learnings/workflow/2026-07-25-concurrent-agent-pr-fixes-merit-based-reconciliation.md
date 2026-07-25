---
title: When a peer pr-fix agent pushes to the same branch, adopt remote as base and reconcile fixes on merit
category: workflow
tags:
  - concurrent-agents
  - pr-review
  - rebase
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

A second automated agent (a pr-fix routine) pushed fixes for the same review
findings to the same branch, rejecting a direct push. Rather than force-pushing
over it, adopted the remote as the base, then compared both sets of fixes finding
by finding: kept theirs where better (they'd independently caught a REST v1
response-contract leak this session had missed), and re-applied this session's
fix where stronger (a server-side re-decide-under-lock vs. their client-side
re-read for the same visibility race).

## Root Cause

Two agents working the same review findings in parallel will produce divergent,
sometimes-better, sometimes-worse fixes for the same issue. A naive
force-push/adopt-mine or adopt-theirs both risk losing a genuinely better fix.

## Solution

Treat the remote push rejection as a signal to diff both fixes for the same
finding, not as a conflict to blindly resolve one way. Keep whichever fix is
stronger per finding; never force-push over a peer agent's work.

## Prevention

- See also `security/2026-06-23-codeql-user-controlled-bypass-dismissal-and-concurrent-agents.md`
  for the reset-and-reapply mechanics when a peer agent pushes concurrently — this
  adds the "compare on merit, don't just adopt one side" step for overlapping
  review-fix content.
