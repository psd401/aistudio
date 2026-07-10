---
title: X-Frame-Options SAMEORIGIN blocks cross-origin iframe embeds — use CSP frame-ancestors instead
category: security
tags:
  - iframe
  - X-Frame-Options
  - CSP
  - frame-ancestors
  - CDK
  - ResponseHeadersPolicy
  - cross-origin
severity: high
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 2 sandboxed iframe was rendered from sandbox-origin.com but embedded by the app at app-origin.com. CDK's `ResponseHeadersPolicy.securityHeadersBehavior.frameOptions` was set to `SAMEORIGIN`, which browsers enforce at the HTTP header level — the embed was blocked even though the app itself is a legitimate framing origin.

## Root Cause

`X-Frame-Options: SAMEORIGIN` is a coarse header with no allowlist — it either allows same-origin frames or blocks everything. When the sandbox page and the embedding app are on different origins by design, `SAMEORIGIN` is the wrong tool. `CSP: frame-ancestors` is origin-precise and supersedes XFO in modern browsers, but older browsers honor XFO first.

## Solution

- **Omit** `frameOptions` from CDK `ResponseHeadersPolicy.securityHeadersBehavior` entirely (do not set it to `SAMEORIGIN`).
- Set `Content-Security-Policy: frame-ancestors 'self' https://app-origin.com` on the sandbox page's CloudFront response headers policy.
- The CDK `ResponseHeadersPolicy` construct exposes `customHeadersBehavior` for free-form CSP headers if the built-in `contentSecurityPolicy` prop is insufficient.

## Prevention

Any page intended to be embedded cross-origin: omit XFO, use `frame-ancestors` with an explicit list. Never set `frameOptions: SAMEORIGIN` on sandbox pages that are designed to be framed by a different origin.
