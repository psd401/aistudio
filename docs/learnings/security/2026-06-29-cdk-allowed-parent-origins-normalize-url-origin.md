---
title: CDK allowedParentOrigins must be URL.origin-normalized before baking into static pages
category: security
tags:
  - CDK
  - postMessage
  - iframe
  - origin-normalization
  - allowlist
  - sandbox
severity: high
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

A CDK prop (`allowedParentOrigins`) was baked into a static HTML page via `JSON.stringify` at deploy time. The raw value had a trailing slash (`https://app.example.com/`). Browsers report `event.origin` as `https://app.example.com` (no trailing slash, no path). The `isAllowedOrigin` check used exact string equality, so every postMessage from the app was silently rejected.

## Root Cause

`window.location.origin` and `event.origin` are canonical: lowercase scheme + host + port, no trailing slash, no path. Any string stored in config must match this canonical form exactly. CDK props that look like origins are not automatically normalized.

## Solution

Normalize before `JSON.stringify`:

```typescript
const normalizedOrigins = rawOrigins.map(o => new URL(o).origin);
const pageContent = templateHtml.replace(
  '__ALLOWED_ORIGINS__',
  JSON.stringify(normalizedOrigins)
);
```

Then in the browser:

```typescript
function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin); // already normalized at build time
}
```

## Prevention

Any config value compared against `event.origin` or `window.location.origin` must be normalized with `new URL(raw).origin` before storage. Do this at CDK/build time, not at runtime, so the cost is paid once.
