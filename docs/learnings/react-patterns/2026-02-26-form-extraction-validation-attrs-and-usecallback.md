---
title: Form component extraction — carry validation attrs explicitly; don't wrap useState setters in useCallback
category: react-patterns
tags:
  - react-forms
  - form-extraction-refactor
  - useCallback
  - accessibility
severity: medium
date: 2026-02-26
source: auto — /review-pr
applicable_to: project
---

## What Happened

During a PR refactoring form fields into extracted components, two issues appeared: (1) `maxLength`, `aria-required`, and `aria-invalid` attributes were dropped — they didn't transfer from the inline JSX to the new component's props. (2) A `useCallback` wrapping a `useState` setter was flagged as unnecessary.

## Root Cause

1. Validation attributes are easy to overlook in refactors because they sit alongside unrelated props; there's no compiler error when they're missing.
2. `useState` setters are already referentially stable — React guarantees this. Wrapping them in `useCallback` adds noise with no benefit.

## Solution

When extracting form fields into components:
- Explicitly audit and carry over: `maxLength`, `minLength`, `required`, `aria-required`, `aria-invalid`, `aria-describedby`, character counters, and any `onBlur` validation triggers.
- Remove `useCallback` wrappers around raw `useState` setters:

```tsx
// Unnecessary
const handleChange = useCallback((val: string) => setValue(val), [])

// Correct — setValue is already stable
<Input onChange={setValue} />
```

## Prevention

- During form extraction PRs, explicitly check each removed JSX attribute against the new component's prop interface.
- Treat accessibility attributes (`aria-*`) and HTML validation attributes as a required audit step, not optional cleanup.
- Lint rule candidate: no `useCallback` wrapping a single-expression `setState` call with no additional logic.
