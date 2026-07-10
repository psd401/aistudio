---
title: "RSC notFound() mock must throw a sentinel defined INSIDE the jest.mock factory to avoid TDZ"
category: test-failures
tags:
  - jest
  - rsc-testing
  - next-navigation
  - notFound-mock
  - hoisting-tdz
  - idor
  - existence-masking
  - atrium
severity: high
date: 2026-06-30
source: auto — /review-pr
applicable_to: project
---

## What Happened

Adding unit coverage for the IDOR-critical 404-existence-masking decision in `/c/[slug]` (ReaderPage RSC). The standard `jest.config` maps `next/navigation` to a no-op `notFound()` stub. Tests needed to assert the page calls `notFound()` for unauthorized viewers.

## Root Cause

Two compounding issues:

1. **No-op stub hides 404 branch**: the default mock returns `undefined`; the page's `notFound()` call is silent, so tests pass whether or not the 404 path executes.
2. **TDZ crash on sentinel defined outside the factory**: `jest.mock()` is hoisted above all `import` statements by babel-jest. Any `const sentinel = new Error(...)` defined in the outer module scope runs *after* the hoisted mock factory — the factory closes over a binding that is not yet initialized, producing "Cannot access 'sentinel' before initialization".

## Solution

Define the sentinel **inside** the `jest.mock` factory and re-export it so the test body can import it back:

```typescript
// In the test file
let notFoundSentinel: Error;

jest.mock("next/navigation", () => {
  // Sentinel lives here — inside the factory, initialized when the factory runs
  const err = new Error("NEXT_NOT_FOUND");
  notFoundSentinel = err;  // capture reference for assertions
  return {
    ...jest.requireActual("next/navigation"),
    notFound: jest.fn(() => { throw err; }),
  };
});

// Cast required — () => never does not overlap jest.Mock directly
import * as nextNavigation from "next/navigation";
const mockNotFound = nextNavigation.notFound as unknown as jest.Mock;
```

Then in each test that expects a 404:
```typescript
await expect(ReaderPage({ params: { slug: "secret-slug" } })).rejects.toThrow(notFoundSentinel);
expect(mockNotFound).toHaveBeenCalledTimes(1);
```

## Prevention

- Whenever testing RSC 404 branches: override the default no-op `notFound` to throw; never assert on a function that returns `undefined` silently.
- Always define sentinel values (errors, symbols) **inside** `jest.mock` factories, never in outer module scope.
- Use `as unknown as jest.Mock` to cast `() => never` typed stubs — direct cast fails TypeScript strict mode.
- File: `tests/unit/atrium-reader-page-masking.test.tsx` is the reference implementation.
