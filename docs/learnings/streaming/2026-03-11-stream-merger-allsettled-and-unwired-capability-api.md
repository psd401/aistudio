---
title: Stream merger must use Promise.allSettled; capability-check APIs often exist but are unwired
category: streaming
tags:
  - streaming
  - error-handling
  - dual-stream
  - tool-validation
  - promise-patterns
severity: high
date: 2026-03-11
source: auto — /work
applicable_to: project
---

## What Happened

Three streaming resilience fixes were implemented: (1) a dual-stream merger switched from `Promise.all` to `Promise.allSettled` so one stream failure doesn't block the other, (2) `getSupportedTools()` — which exists on all adapters — was discovered to never be called in the tool creation path, (3) transient errors got appropriate log levels.

## Root Cause

`Promise.all` short-circuits on first rejection, making independent stream failures cascade. Separately, `getSupportedTools()` was a capability-checking API present on every adapter but never wired into the validation path that creates tools — the check API and the creation path evolved independently.

## Solution

- Replace `Promise.all` with `Promise.allSettled` in any merger that handles independent streams. Emit a warning event type for rejected streams rather than failing the whole merge.
- Retry at the merger level is **impossible** — the merger receives pre-created `StreamTextResult` objects. Retry must be implemented at the route level, before streams are created.
- Wire `getSupportedTools()` into the tool creation flow as a pre-filter. Grep for capability-check method names across adapters when reviewing tool creation code.

## Prevention

- When merging N independent async sources, default to `Promise.allSettled` unless all-or-nothing failure is explicitly desired.
- When adding a new adapter method (especially `getSupported*` / `canHandle*`), immediately search the codebase for the corresponding creation/invocation path and verify the check is wired in.
- Treat unconnected capability-check APIs as latent bugs — they create a false sense of safety.
