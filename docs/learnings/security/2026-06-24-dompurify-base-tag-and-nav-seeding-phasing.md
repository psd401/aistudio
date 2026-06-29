---
title: DOMPurify FORBID_TAGS must include <base>; seed navigation rows only when the target route exists
category: security
tags:
  - dompurify
  - xss
  - base-tag
  - sanitization
  - atrium
  - navigation
  - migration-seeding
  - phasing
  - guest-auth
  - public-content
  - requester
  - s3
  - content-disposition
  - aggregate-error
  - error-handling
  - pr-review
severity: high
date: 2026-06-24
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0 content API) round-6 review surfaced three HIGH findings:
(1) The DOMPurify `FORBID_TAGS` list blocked `style`, `iframe`, `object`, `embed` but
omitted `<base>` — a stored `render.html` snapshot could re-root all relative URLs
via a single `<base href="https://attacker.example">` tag.
(2) Read server actions called `getUserRequester()`, which throws `authNoSession`
before the `canView` access check ran — unauthenticated callers of public Atrium
content got a 401 instead of the content.
(3) Migration 085 seeded `navigation_items` rows (`type='content'`, `link=NULL`)
ahead of the `/atrium` route existing — `buildVisibleNavItems` silently drops them
(NULL link filter) and the route they would link to does not exist yet.

## Root Cause

1. **`<base>` not in DOMPurify default strip list**: DOMPurify's `FORBID_TAGS` does
   not include `<base>` by default. A stored snapshot with `<base href="...">` causes
   all subsequent relative `src`/`href` attributes in the rendered page to resolve
   against the attacker's origin — a stored relative-URL hijacking vector even when
   `<script>` and the obvious XSS tags are blocked.
2. **Hard session requirement on public reads**: `getUserRequester()` throws
   `authNoSession` for unauthenticated requests. Gating a public content endpoint
   behind it collapses the intended "guest can view public content" access model.
3. **Seeding UI rows before the feature is ready**: Inserting navigation items
   before the route and content they link to are deployed results in invisible
   (filtered-out) or broken (404) rows that pollute the DB with dead state.

## Solution

1. Add `'base'` to `FORBID_TAGS` alongside `style`, `iframe`, `object`, `embed`
   everywhere sanitized HTML is persisted and later served.
2. Introduce `getOptionalRequester()` that returns a guest `Requester`
   (`userId: null`) when no session exists; narrow `user.userId` to `number|null`
   and add a `ForbiddenError` guard on write-path actions where `null` is invalid.
3. Defer `navigation_items` seeding to Phase 4 (per the design spec) when the
   `/atrium` route and content records are present. Do not seed schema-groundwork
   rows that no live code surfaces yet.

## Prevention

- **DOMPurify allowlist checklist**: whenever building a `FORBID_TAGS` list for
  persisted HTML, always include: `script`, `style`, `iframe`, `object`, `embed`,
  **`base``. The `<base>` tag is not stripped by default and re-roots relative URLs.
- **Guest-capable endpoints**: if a feature has a "public" access tier, the
  Requester abstraction must support `userId: null` from the first read action.
  Never use `getUserRequester()` (hard-throws) on a potentially-unauthenticated path.
- **Phase-aligned seeding**: only seed navigation items, menu entries, or
  UI-surfaced rows in the migration that also creates or confirms the route/content
  they reference. Early seeding creates invisible dead state.
- See also: [[dompurify-cjs-sanitizer-next-jest-esm-migration-ordering]] for the
  complementary DOMPurify CJS/ESM selection pattern.
