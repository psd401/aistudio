---
title: Two bounds for one input length silently change what the caller searched for; omitting the shared constant from a jest mock crashes zod opaquely
category: test-failures
tags:
  - zod
  - validation
  - jest
  - mocking
  - atrium
  - search
severity: medium
date: 2026-10-04
source: auto — /lfg #1860 (PR #1862)
applicable_to: project
---

## What Happened

The people-search query string was bounded twice: a zod schema at the API
boundary used `.max(200)`, while the shared query function
(`lib/content/people-search.ts`) internally truncated the string at 100
characters before searching. A caller sending a 150-character term passed
validation but was silently searched against a different (truncated) term
than the one it sent — no error, just a wrong-looking result set.

Separately, a jest test mocked `lib/content/people-search.ts` to unit-test the
route in isolation, but the mock didn't re-export the module's
`PEOPLE_SEARCH_MAX_QUERY_LENGTH` constant that the zod schema's
`.max(PEOPLE_SEARCH_MAX_QUERY_LENGTH)` call depends on. The schema evaluated
`.max(undefined)`, and the resulting validation failure crashed inside zod's
own locale error builder with `Cannot read properties of undefined (reading
'toString')` — a failure that gives no hint the root cause is a missing mock
export.

## Root Cause

The bound existed as two literals (200 at the schema, 100 in the query) instead
of one shared value, so they could (and did) drift. And a constant consumed by
a zod `.max()` call is a hidden dependency of any test that mocks the module
exporting it — `jest.mock()` with a partial manual mock silently drops
exports the test author didn't think to list.

## Solution

Export a single `PEOPLE_SEARCH_MAX_QUERY_LENGTH` constant from
`lib/content/people-search.ts` and use it in both the zod schema's `.max()`
and the query function's own truncation — one number, enforced identically at
both the boundary and the implementation.

## Prevention

- Never hardcode a length/size bound in two places when a route validates
  input that a shared function also bounds internally — export one constant,
  import it at both sites.
- When mocking a module that exports a constant consumed by a zod schema
  (`.max()`, `.min()`, `.length()`), re-export that constant in the mock even
  if the test doesn't assert on it directly — a missing export reads as a
  generic zod-internal crash (`toString` on undefined), not a "mock is
  incomplete" error.
