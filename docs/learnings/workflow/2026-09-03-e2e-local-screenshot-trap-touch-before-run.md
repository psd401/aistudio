---
title: e2e-local.sh exit trap deletes screenshots a run created — touch target paths before running
category: workflow
tags:
  - e2e
  - e2e-local.sh
  - playwright
  - screenshots
  - bash-trap
  - evidence
applicable_to: project
severity: medium
date: 2026-09-03
source: auto — /lfg
---

## What Happened

Adding E2E coverage for issue #1714 meant two NEW evidence screenshots under
`.verification/`, written by the specs during a `scripts/test/e2e-local.sh` run. A
prior session had lost such files: they were on disk while the suite ran and gone once
it finished, even though the specs clearly wrote them. This time the target paths were
`touch`ed before the run and both PNGs survived — recording the mechanism here so the
workaround is discoverable from the repo, not only from one agent's memory.

## Root Cause

`scripts/test/e2e-local.sh`'s `on_exit` trap calls `restore_untouched_shots()`
(lines ~89-111), which snapshots `git status --porcelain -uall` for `.verification` and
`docs/verification` **before** the run (`PRE_DIRTY_SHOTS`) and, on exit, `rm -f`s any
file whose status is `??` (untracked) that was NOT already in that pre-run snapshot,
and `git checkout --`s any tracked file the run modified that wasn't already dirty.
This is intentional — it stops incidental screenshot churn from polluting the working
tree — but it means any screenshot a run creates fresh is deleted unless it already
existed (even as an empty/untracked file) before the run started.

## Solution

`touch` the exact target screenshot path(s) before invoking `e2e-local.sh` so they
appear in `PRE_DIRTY_SHOTS` as already-untracked, which exempts them from the
`rm -f` branch and lets the run's real content survive.

## Prevention

- Before running `scripts/test/e2e-local.sh` when you need to keep screenshots the run
  produces as evidence, `touch` each target path first.
- Files already tracked and dirty before the run are always preserved as-is — only
  fresh (`??`) or newly-modified-by-this-run files are cleaned up.
