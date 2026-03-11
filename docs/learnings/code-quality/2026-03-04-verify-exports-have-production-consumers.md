---
title: Verify every new export has a production consumer before opening a PR
category: code-quality
tags:
  - dead-code
  - exports
  - pre-pr-checklist
  - streaming
  - error-boundary
  - react
severity: medium
date: 2026-03-04
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #822 added `isSafePlotData` and `SAFE_PLOT_MIME_TYPES` as named exports from a shared utility module. Neither was imported anywhere in production code. The dead exports were discovered during review (round 3+), causing friction and requiring a cleanup commit.

## Root Cause

New helpers were written and exported speculatively — useful in tests or anticipated for future use — but no production call site was wired up before the PR was opened.

## Solution

Before opening a PR, run a grep check for every new export name:

```bash
grep -rn "isSafePlotData\|SAFE_PLOT_MIME_TYPES" app/ components/ actions/ lib/
```

If the only hits are the definition file and test files, the export is untethered. Either wire it up or remove the `export` keyword until it is needed.

## Prevention

Add to pre-PR checklist: for each newly exported symbol, confirm at least one non-test import exists. A single grep per symbol takes seconds and eliminates reviewer friction around dead-code questions.
