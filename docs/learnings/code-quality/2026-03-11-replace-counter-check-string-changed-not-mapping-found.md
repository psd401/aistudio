---
title: Replace-loop metric must check string changed, not mapping found
category: code-quality
tags:
  - metrics
  - testing
  - string-replace
  - mock-teardown
  - naming
severity: medium
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #844 fixed PII batch deduplication. A `replacementsApplied` counter incremented whenever a map lookup succeeded inside a `String.replace()` callback. An edge case existed where a prior loop iteration had already substituted the placeholder, so the lookup succeeded but the string did not actually change — double-counting the metric.

## Root Cause

`mapping found` (truthy map value) and `string changed` (before !== after) are not equivalent when the same placeholder pattern can appear in a value that was already rewritten by an earlier pass.

## Solution

Capture the string before calling `.replace()`, then compare before/after:

```typescript
const before = current;
current = current.replace(pattern, (match) => mapping.get(match) ?? match);
if (current !== before) replacementsApplied++;
```

## Prevention

- Whenever a counter is incremented inside a `.replace()` callback, ask: "could this callback fire without the string net-changing?"
- Add a unit test with a value that already contains the placeholder literal to assert the counter does not double-increment.
- Secondary items from the same PR: add `afterEach(() => jest.clearAllMocks())` to dedup test blocks; prefer interface names that cannot be confused with SDK types (e.g., `BatchGetInput` vs `BatchGetItemCommandInput`).
