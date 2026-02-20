---
title: Lazy useState initializer for error-driven initial UI state
category: react-patterns
tags:
  - useState-lazy-init
  - accessibility
  - aria
  - isPlainObject
  - https-restriction
  - CodeQL
  - YAGNI
  - connector-tools
severity: medium
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #795 (connector tool call UI) introduced a collapsible component that needed to start expanded when its content had an error. Initial implementation used `useState(false)` + `useEffect` to set state after mount, causing a flash of collapsed UI before the effect fired.

## Root Cause

`useEffect` runs after render, so any state correction based on props/parse results is always one render late. This produces a visible flash when the correct initial state differs from the default.

## Solution

Use the lazy initializer form of `useState` to derive the correct initial value at mount time:

```tsx
// Bad — causes flash on error state
const [isCollapsed, setIsCollapsed] = useState(false);
useEffect(() => {
  if (parseResult.isError) setIsCollapsed(false);
}, [parseResult.isError]);

// Good — correct initial render, no flash
const [isCollapsed, setIsCollapsed] = useState(
  () => !parseResult.isError
);
```

## Prevention

- Any time initial UI state depends on a prop or parsed value, use the lazy `useState(() => compute(prop))` form.
- Reserve `useEffect` for side effects that must run in response to *changes*, not for correcting initial state.
- Applies to: expand/collapse, active tab selection, visibility toggles derived from error/status props.
