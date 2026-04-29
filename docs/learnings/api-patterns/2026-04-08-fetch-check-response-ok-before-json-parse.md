---
title: Check response.ok before JSON parsing — non-JSON ALB/infra errors are silently swallowed by .catch(() => fallback)
category: api-patterns
tags:
  - error-handling
  - fetch
  - alb
  - s3
  - upload
  - diagnostics
severity: high
date: 2026-04-08
source: auto — /work
applicable_to: project
---

## What Happened

PDF uploads in Nexus (#867) were failing with generic "Server processing failed" messages. The root cause was transient ALB 502/503 and S3 unavailability, but all diagnostic signal was lost because error handling swallowed it at 3 layers: server classification stripped raw errors, client silently caught non-JSON ALB HTML responses with `response.json().catch(() => fallback)`, and the UI showed a generic message for all failures.

## Root Cause

When the ALB returns a 502/503 with an HTML body, `response.json()` throws a parse error. Using `.catch(() => ({ error: 'Upload failed' }))` as a fallback silently discards the HTTP status code and the actual error body, making infra failures indistinguishable from application errors.

## Solution

Always check `response.ok` first, then attempt JSON parsing. Handle non-JSON responses explicitly with the HTTP status code:

```typescript
const response = await fetch('/api/upload', { ... });

if (!response.ok) {
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);
  throw new Error(`Upload failed: HTTP ${response.status} — ${body ?? 'no body'}`);
}

const data = await response.json();
```

## Prevention

- Never use `response.json().catch(() => fallback)` as the sole error path — it hides HTTP status codes.
- Check `response.ok` (or `response.status`) before attempting to parse the body.
- Log or surface the raw HTTP status code from failed responses so infra errors (502/503) are distinguishable from app errors (400/422/500).
- When diagnosing "generic error" UX bugs, audit every `.catch()` on a `.json()` call in the fetch chain.
