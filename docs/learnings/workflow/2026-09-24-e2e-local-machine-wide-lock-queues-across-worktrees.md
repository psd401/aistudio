---
title: scripts/test/e2e-local.sh takes a machine-wide lock — parallel worktree sessions queue behind each other
category: workflow
tags:
  - e2e
  - e2e-local.sh
  - worktrees
  - lock
  - parallel-sessions
severity: low
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

While running local E2E for issue #1697, `scripts/test/e2e-local.sh` queued
for a long time. The script takes a single machine-wide lock at
`/tmp/aistudio-e2e-local.lock`, so any other worktree/session running the
script at the same time serializes behind it.

## Root Cause

The lock file path is not scoped per-worktree or per-branch, so concurrent
LFG/work sessions across different worktrees on the same machine contend for
one lock. It does auto-reap a stale lock via `kill -0` on the recorded PID.

## Solution

No code change needed — this is expected behavior. Wait for the queue rather
than intervening.

## Prevention

- Do not `kill` another session's `e2e-local.sh` run to jump the queue — see
  [[feedback_scope_process_kills_to_worktree]] in the shared user memory.
- If a run seems permanently stuck (not just queued), check whether the lock
  is genuinely stale (`kill -0 <pid>` fails) before assuming it needs manual
  cleanup — the script already does this on next invocation.
