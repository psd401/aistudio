---
title: Next.js App Router dispatches Server Actions strictly one at a time
category: performance
tags: [nextjs, server-actions, concurrency, app-router]
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Atrium's live-data artifact dashboards fired 6 concurrent queries via `Promise.all`, but they ran back-to-back on prod (~6.5s for ~1.2s of actual work). Issue #1788.

## Root Cause

`queryArtifactData` was called as a Next.js Server Action. The App Router client-side runtime queues and dispatches Server Action calls **strictly one at a time**, regardless of how many are fired concurrently from the client (`Promise.all`, parallel hooks, etc.). This is a client dispatch limitation, not a server-side bottleneck — the server could easily handle them in parallel.

## Solution

Moved the query off the Server Action path onto a real HTTP endpoint: `POST /api/atrium/artifacts/[id]/query` (`app/api/atrium/artifacts/[id]/query/route.ts`). The route calls `queryArtifactData` in-process (delegating all authz to it — see [[architecture/2026-09-24-route-handler-calling-server-action-is-not-a-network-hop]]), but because the client now issues plain `fetch()` calls instead of Server Action RPCs, the browser's normal HTTP concurrency applies and requests run in parallel.

## Prevention

- Any UI that needs to fire multiple mutations/queries concurrently from the client should NOT route them through `"use server"` Server Actions — use a Route Handler (`fetch`) instead.
- If you see unexplained serialization of concurrent operations that individually profile fast, check whether they're Server Actions before assuming a server-side lock or connection-pool limit.
