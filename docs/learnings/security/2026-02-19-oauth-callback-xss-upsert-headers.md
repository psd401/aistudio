---
title: OAuth callback HTML pages have three XSS vectors plus require atomic upsert for token storage
category: security
tags:
  - oauth
  - xss
  - upsert
  - security-headers
  - access-control
  - html-rendering
  - postmessage
severity: critical
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #792 (Issue #779 OAuth popup flow) security audit caught four issues in the OAuth callback route: missing authorization gate (any authenticated user could OAuth any connector), reflected XSS via provider-controlled `error_description` injected raw into HTML, non-atomic check-then-insert race on concurrent re-auth, and missing security headers plus a double `JSON.stringify` bug in the postMessage payload.

## Root Cause

OAuth callback endpoints that render HTML are a higher-risk surface than JSON API routes. Provider-controlled query params flow into HTML, embedded script tags need explicit escaping, and HTTP security headers are not applied by default. Token upsert logic written as check-then-insert is not safe under concurrent requests.

## Solution

**Three XSS vectors to check in any HTML-rendering endpoint:**

1. **Provider query params in HTML body** — always escape before interpolation:
   ```typescript
   const safe = encodeURIComponent(raw).replace(/%20/g, " ");
   // or use a sanitize helper; never interpolate req.query.* raw into HTML
   ```

2. **JSON embedded in `<script>` tags** — must escape `<` to prevent `</script>` injection:
   ```typescript
   const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
   // postMessage payload: JSON.stringify(payload) once — NOT JSON.stringify(JSON.stringify(...))
   ```

3. **Security headers on HTML responses** — add to every `text/html` response:
   ```typescript
   res.setHeader("X-Frame-Options", "DENY");
   res.setHeader("X-Content-Type-Options", "nosniff");
   res.setHeader("Cache-Control", "no-store");
   ```

**Atomic upsert for token storage** — collapse check-then-insert to a single statement:
```typescript
// Bad: SELECT then INSERT/UPDATE — race condition on concurrent re-auth
// Good: single atomic upsert
await db.insert(oauthTokens)
  .values({ userId, connectorId, ...tokenData })
  .onConflictDoUpdate({
    target: [oauthTokens.userId, oauthTokens.connectorId],
    set: { ...tokenData, updatedAt: new Date() },
  });
```

**Authorization gate** — assert user owns the connector before issuing tokens:
```typescript
await requireUserAccess(session.userId, connectorId);
```

## Prevention

- Every HTML-rendering API route needs a checklist: escape all query params, escape embedded JSON, add X-Frame-Options/X-Content-Type-Options/Cache-Control headers
- Token storage for OAuth must always use `INSERT ... ON CONFLICT DO UPDATE` — never check-then-insert
- All connector-scoped routes must call `requireUserAccess` before any data operation
- postMessage payloads: `JSON.stringify` exactly once; double-stringify is a latent bug that silently breaks the receiver
