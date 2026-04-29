---
title: Feature removal leaves dead helpers, stale comments, and log field inconsistencies
category: code-quality
tags:
  - dead-code
  - feature-removal
  - consistency
  - review-patterns
  - logging
severity: medium
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #841 removed CloudWatch publishing from a chat route. After removal, a helper (`handleChatError`) remained exported but was never called outside its own file. A stale comment referencing the removed feature persisted. Log fields (`blockedCategories`, `source`) were present in two routes but missing from parallel routes handling the same error type.

## Root Cause

Feature removal focuses on the primary deletion path. Secondary artifacts — exported helpers that existed to support the removed feature, inline comments explaining the old behavior, and log fields added alongside the feature — are easy to miss because they don't cause build or runtime errors.

## Solution

After any feature removal, run three checks before opening a PR:

1. **Dead helpers**: grep for every function/constant defined in the affected file to confirm each has at least one external caller:
   ```bash
   grep -rn "handleChatError" app/ actions/ lib/ components/
   ```
   If the only hits are the definition file, remove the export (or the function entirely).

2. **Stale comments**: scan the diff for comments that reference the removed feature by name — they are documentation lies once the code they describe is gone.

3. **Log field parity**: when a log field is added to one route handler, grep for sibling routes handling the same error type and confirm the field is present in all of them.

## Prevention

Add to the feature-removal PR checklist: grep all exported symbols in touched files; scan for comments mentioning the removed feature name; compare log fields across all parallel route handlers.
