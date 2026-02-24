---
title: Derived-state toggle must invert displayed value, not stored value
category: react-patterns
tags:
  - derived-state
  - useCallback
  - hooks-ordering
  - connector-tools
  - mcp
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #795 added auto-expand behavior to connector tool call/result UI in Nexus chat. The component used a `null|boolean` state (`manualExpanded`) where `null` means "follow auto-expand logic" and `true|false` means "user has overridden." The toggle callback was written as `prev === null ? true : !prev`, which caused a double-click-to-collapse bug: first click set `manualExpanded=true` without inverting the auto-expanded state.

## Root Cause

The toggle logic inverted the **stored** value (`manualExpanded`) rather than the **displayed** value (what the user actually sees). When auto-expand opens the panel (`manualExpanded=null`, derived display=`true`), clicking "collapse" set `manualExpanded=true` (still open) instead of `false` (closed). A second click was required to actually collapse.

## Solution

Invert the **currently displayed** state, not the stored state:

```typescript
// Wrong — inverts stored state, misses first click
const toggle = useCallback(() => {
  setManualExpanded(prev => prev === null ? true : !prev);
}, []);

// Correct — inverts displayed state
const toggle = useCallback(() => {
  setManualExpanded(prev => !(prev !== null ? prev : derivedAutoExpand));
}, [derivedAutoExpand]);
```

The formula `!(prev !== null ? prev : derivedValue)` evaluates the effective display state first, then inverts it — handling the `null` (first-click) case correctly.

## Prevention

Whenever a `null|T` override state pattern is used alongside auto/derived behavior, test the first user interaction specifically. The toggle's captured dependency (`derivedAutoExpand`) must be stable — compute it outside the callback or include it in the `useCallback` dep array.
