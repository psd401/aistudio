---
title: OAuth popup flow checklist — per-resource cookies, CSP, Zod parsing, CodeQL bypass false positives
category: security
tags:
  - oauth
  - cookies
  - concurrent-flows
  - csp
  - zod
  - external-api-validation
  - codeql
  - state-parameter
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #792 (Issue #779) OAuth popup flow went through 5 review rounds with ~20 findings. Beyond the XSS/upsert issues documented separately, four additional patterns were caught: shared cookie names causing concurrent popup collisions, missing CSP header on inline-script callback pages, manual type-cast validation of external token responses instead of Zod, and CodeQL `js/user-controlled-bypass` firing on standard null/presence guards.

## Root Cause

OAuth popup flows open multiple windows concurrently (user can re-open before the first completes). Shared cookie names mean the second popup overwrites state from the first. Inline-script HTML pages need a CSP header the existing security-headers checklist did not include. External API responses (provider token endpoint) were cast with `as TokenResponse` instead of being parsed, hiding shape mismatches at runtime.

## Solution

**Per-resource cookie names — prevent concurrent flow collision:**
```typescript
// Bad: shared name — second popup overwrites first
const COOKIE_NAME = "oauth_state";

// Good: include full resource ID so each popup has its own cookie
const cookieName = `oauth_state_${serverId}`;
res.setCookie(cookieName, encryptedState, { httpOnly: true, sameSite: "lax", path: "/" });
```

**CSP header on inline-script callback pages:**
```typescript
res.setHeader(
  "Content-Security-Policy",
  "default-src 'none'; script-src 'unsafe-inline'"
);
// postMessage pages need script-src 'unsafe-inline'; everything else blocked
```

**State parameter can carry routing metadata:**
```typescript
// State is opaque to OAuth providers — safe to prefix with routing info
const state = `${serverId}:${cryptoRandomToken}`;
// On callback: split on first ":" to extract serverId, validate UUID before use
const [stateServerId, ...rest] = rawState.split(":");
if (!isUUID(stateServerId)) throw new Error("Invalid state");
```

**Zod for external token response parsing:**
```typescript
import { z } from "zod";

const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

const raw = await fetch(tokenEndpoint, ...).then(r => r.json());
const token = TokenResponseSchema.parse(raw); // throws on shape mismatch
```

**CodeQL `js/user-controlled-bypass` — context-dependent, not always a false positive:**
- On null/presence guards (e.g., `if (!userId) throw`): false positive — dismiss
- On OAuth callbacks: **inspect handler order first** — if `errorParam` is checked before state cookie validation, CodeQL is correct; fix the order, don't dismiss
- See `security/2026-02-20-oauth-callback-validation-order.md` for the real-vulnerability case

## Prevention

- OAuth multi-step flows: cookie name must include the full resource ID (`oauth_state_${serverId}`)
- HTML pages with `<script>` blocks: add `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'`
- State parameter validation: extract and UUID-validate `stateServerId` before first database use
- Any external API response (provider token endpoint, third-party service): parse with Zod, never `as T`
- CodeQL `js/user-controlled-bypass` on validation guards: dismiss as false positive
