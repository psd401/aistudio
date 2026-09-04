---
title: Drizzle and() silently drops undefined operands, so an SQL | undefined gate helper is fail-open by type
category: security
tags:
  - atrium
  - drizzle
  - and-undefined
  - visibility
  - fail-open
  - authorization
severity: high
date: 2026-09-03
source: /lfg #1726 (PR #1732)
applicable_to: project
---

## What happened

Issue #1726 consolidated Atrium's "is this object live?" check into one helper,
`lib/content/live-publication.ts`, shared by five gates on what ANONYMOUS visitors
may read: the public reader `/p/[slug]`, the internal reader `/c/[slug]`, the
sitemap, the public asset-bytes route, and the public embed resolver.

The helper built its two conditions with `and(...)` and therefore returned
`SQL | undefined` — that is what drizzle's `and()` is typed to return. Callers did
`and(eq(contentPublications.objectId, id), isLivePublicationRow())`.

**No dropped condition was ever observed.** This was caught by review, on the type,
before it could happen. That is the point: nothing in the type system, the tests, or
a code read of the call site distinguishes "this helper returned a real condition"
from "this helper returned undefined and the gate now matches every row".

## Root cause

`and(a, b, c)` accepts `SQL | undefined` per argument BY DESIGN, so callers can build
conditions with optional legs, and it **omits** undefined operands from the `WHERE`
rather than erroring. A bug producing `undefined` is therefore indistinguishable from
a deliberate omission.

For a gate helper the two have opposite security meanings. A gate that loses its
condition does not throw and does not return zero rows — it returns MORE rows. Here
that would have meant `/p/{slug}` serving any object carrying any publication row
(an OKF export bundle, a retracted row, a connector push), and the sitemap
advertising them to crawlers. Most "does it filter?" tests still pass, because they
assert that a gated row is absent, not that an ungated row is.

## Fix

Return a non-optional tuple and spread it into the caller's own `and(...)`:

```ts
export function livePublicationConditions(): readonly [SQL, SQL] {
  return [
    inArray(contentPublications.destination, [...LIVE_SURFACE_DESTINATIONS]),
    eq(contentPublications.status, "live"),
  ];
}
// call site
.where(and(eq(contentPublications.objectId, obj.id), ...livePublicationConditions()))
```

`inArray` and `eq` each return a non-optional `SQL`, so the unsafe state is
unrepresentable rather than merely unlikely.

## Prevention

- A predicate helper backing an authorization or visibility gate must not be typed
  `SQL | undefined`. Return non-optional `SQL`, or a non-optional tuple/array to
  spread — so a missing condition is a type error, not a dropped `WHERE` clause.
- Wrapping conditions in `and()` inside the helper is what introduces the optional
  type. Hand the caller the conditions; let the caller combine them.
- When testing a gate, assert it returns FEWER rows than the unscoped query, not
  merely that a specific gated row is absent. The failure mode is over-return.
