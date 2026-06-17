---
title: Next.js App Router API routes using AWS SDK or Buffer must declare nodejs runtime
category: integration
tags:
  - nextjs
  - app-router
  - edge-runtime
  - aws-sdk
  - api-routes
  - error-handling
  - http-status
  - s3
  - path-traversal
  - pr-review
severity: high
date: 2026-06-17
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1034 (skill platform, Issue #925) review surfaced missing `export const runtime = "nodejs"` in App Router API routes that imported `@aws-sdk/*` clients or used `Buffer`/`JSZip`. Without the declaration Next.js can silently place these routes on the Edge runtime, where AWS SDK, Buffer, and Node-native modules are unavailable. The failure is runtime-only — typecheck, lint, and CI all pass green.

## Root Cause

Next.js App Router defaults to the Edge runtime for some API route configurations. When a route imports Node-only modules (`@aws-sdk/*`, `Buffer`, `JSZip`) without pinning the runtime, the mismatch only surfaces at request time in production.

## Solution

Add `export const runtime = "nodejs"` at the top of every App Router API route file (`app/api/**/route.ts`) that:
- Imports any `@aws-sdk/*` client
- Uses `Buffer`, `JSZip`, or other Node-native modules
- Performs S3 or other AWS SDK operations

This is the established project convention; all existing AWS SDK routes already pin it.

Two additional patterns fixed in the same PR:

**HTTP status from error code** — `handleError` returns an `ActionState` with no HTTP status. API route catch blocks must derive status from `AppError.code` via `ERROR_STATUS_CODES` in `types/error-types.ts` instead of returning a blanket `500`.

**S3 key path guard** — S3-key-to-zip path construction should strip `../` sequences and leading `/` as defense-in-depth even when upload-time validation exists.

## Prevention

- Code-review checklist: any new `app/api/**/route.ts` that touches AWS SDK or Node builtins must include the runtime declaration.
- Grep for `@aws-sdk` imports in route files and verify `runtime = "nodejs"` is present.
- Lint rule or project template can enforce this; currently relies on review.
