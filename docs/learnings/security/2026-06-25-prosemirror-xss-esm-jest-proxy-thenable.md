---
title: ProseMirror is not a sanitizer; ESM-blocked jest paths need Bun smokes; Proxy tx-stubs must return undefined for `then`
category: security
tags:
  - atrium
  - collab
  - xss
  - prosemirror
  - marked
  - jest
  - bun-smoke
  - proxy-thenable
  - redis
  - server-actions
  - review-pr
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1062 (Atrium Phase 1 collab) had an XSS path where raw HTML reached
`generateJSON` (ProseMirror schema parser) via the editor-seeding flow. The
security-critical paths could not be covered by Jest because TipTap/Yjs/marked
are pure-ESM and not jest-loadable. Jest Proxy transaction stubs were also
hanging tests due to a thenable trap.

## Root Cause

Three distinct root causes surfaced together:

1. **XSS**: `marked` was converting markdown to HTML and the output was fed
   directly into `generateJSON`. ProseMirror's schema parser is NOT a sanitizer
   — it will faithfully parse `<script>` and event-handler attributes.
2. **ESM coverage gap**: TipTap, Yjs, `marked`, and `jose` cannot be loaded by
   Jest (pure-ESM). Security-critical logic that imports them had zero test
   coverage because the modules errored on require.
3. **Proxy thenable hang**: A chainable Proxy stub used for Drizzle
   transactions (`tx.update().set().where()`) did not define a `then` property.
   `await` checks for `.then` — if the Proxy intercepts and returns the proxy
   itself, the awaited expression becomes a never-resolving thenable and the
   test hangs indefinitely.

## Solution

1. **XSS fix**: Override the `marked` renderer before parsing:
   `renderer.html = () => ""` — strips raw HTML blocks at the markdown layer so
   nothing unsanitized reaches the editor model.
2. **ESM coverage**: Write Bun smoke tests (`tests/smoke/*.smoke.ts`) for any
   security path that is not jest-loadable. Bun runs ESM natively. Three new
   smoke files covered the sanitizer, collab token, and seed path.
3. **Proxy thenable fix**: In the jest chainable Proxy factory, explicitly
   return `undefined` for the `then` property:
   ```ts
   get(_, prop) {
     if (prop === "then") return undefined; // prevent await trap
     return chainable;
   }
   ```

## Prevention

- Never assume `generateJSON` or any schema parser sanitizes input — always
  strip HTML before feeding markdown-derived content into a rich-text model.
- When a module is pure-ESM and jest-unfriendly, do NOT skip coverage — write
  a Bun smoke test in `tests/smoke/`.
- Any jest Proxy stub that will be `await`ed must explicitly trap `then` and
  return `undefined`, otherwise the proxy masquerades as a thenable.
