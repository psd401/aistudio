---
title: OAuth callback — state cookie must be validated BEFORE errorParam or code checks
category: security
tags:
  - oauth
  - csrf
  - codeql
  - callback
  - state-validation
  - mcp
severity: high
date: 2026-02-20
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #799 surfaced a real `js/user-controlled-bypass` CodeQL alert on the MCP OAuth callback handler. The handler checked `errorParam` (a user-supplied query param) first and returned early, meaning the state cookie CSRF validation was never reached when `errorParam` was present. An attacker could trigger the early return with a crafted `error` query parameter, bypassing CSRF protection entirely.

## Root Cause

Callback handler structure placed the user-controlled branch before the security gate:

```typescript
// BAD — errorParam checked before state cookie is validated
const errorParam = req.query.error;
if (errorParam) return res.status(400).json({ error: errorParam }); // ← bypasses CSRF check

const cookieState = getCookie("oauth_state_...");
if (!cookieState || cookieState !== req.query.state) return res.status(403)...
```

CodeQL correctly identifies this as `js/user-controlled-bypass` — it is NOT a false positive here.

## Solution

Restructure so the state cookie validation is unconditional — it runs before any branch on user-supplied parameters:

```typescript
// GOOD — security gate is always first
const cookieState = getCookie(`oauth_state_${serverId}`);
if (!cookieState) return res.status(403).json({ error: "Invalid session" });

const { oauthState } = decryptState(cookieState);
if (oauthState !== req.query.state) return res.status(403).json({ error: "State mismatch" });

// NOW safe to handle errorParam — CSRF is already validated
const errorParam = req.query.error;
if (errorParam) return res.status(400).json({ error: "OAuth provider error" });
```

Storing the SDK-generated `authUrl` state in the encrypted cookie enables timing-safe comparison in the callback without a separate database round-trip.

## Prevention

- In any OAuth callback: state cookie validation must be the **first** conditional block, before `errorParam`, `code`, or any other user-supplied query param check
- If CodeQL flags `js/user-controlled-bypass` on an OAuth callback, **inspect the handler order** before dismissing — it may be a real vulnerability
- Only dismiss `js/user-controlled-bypass` as a false positive on null/presence guards that are not security checkpoints (see `security/2026-02-19-oauth-popup-flow-checklist.md`)
