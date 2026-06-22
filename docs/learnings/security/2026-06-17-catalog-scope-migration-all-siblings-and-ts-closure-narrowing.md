---
title: Migrate ALL sibling endpoints when introducing catalog-resolved scopes; avoid redundant re-fetch and TS closure casts
category: security
tags:
  - authorization
  - api-scopes
  - tool-catalog
  - typescript-narrowing
  - code-review
  - single-source-of-truth
  - nextjs-route-handlers
severity: high
date: 2026-06-17
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1038 introduced a "single source of truth" pattern where authorization scopes are resolved from the tool catalog rather than hardcoded. The primary execute route was migrated, but the sibling GET `/api/v1/assistants` list route kept its hardcoded `"assistants:list"` scope string. The inconsistency was flagged across three consecutive review passes (Rounds 1, 2, and a @claude re-review) before it was fixed.

Two additional cleanup items appeared in the same PR: `requireExecuteScope` was calling `getRequiredScopes()` (which re-fetched the catalog entry) even though the entry was already in scope; and a `filter.scopes as string[]` cast was needed only because TypeScript does not carry an outer `if (filter.scopes)` guard through an arrow function closure boundary.

## Root Cause

- **Incomplete migration**: When refactoring a pattern across an API surface (e.g., switching from hardcoded scopes to catalog-resolved ones), it is easy to update the "interesting" route (execute) and overlook the "boring" sibling (list). Code review caught this, but it took three passes.
- **Redundant re-fetch**: The `getRequiredScopes` helper was designed for call sites that don't have the entry yet. Calling it when the entry is already in hand re-fetches unnecessarily and obscures the data flow.
- **TypeScript closure narrowing**: A truthy `if (x)` check in the outer scope does not survive into an arrow function body — TypeScript treats closures as potentially stale. Binding `const scopes = filter.scopes` before the closure eliminates both the cast and the ambiguity.

## Solution

1. Replaced the hardcoded `"assistants:list"` scope in the GET route with `entry.surfaceScopes?.rest ?? entry.requiredScopes` — same catalog-resolution pattern used by the execute route.
2. Removed the `getRequiredScopes()` call inside `requireExecuteScope`; read `entry.surfaceScopes?.rest ?? entry.requiredScopes` directly from the already-fetched entry.
3. Introduced `const scopes = filter.scopes` before the arrow function to give TypeScript a narrowed local, removing the `as string[]` cast.

## Prevention

- When introducing a "single source of truth" pattern, enumerate ALL routes/handlers in the same API surface and migrate them in the same PR. A checklist comment in the PR description (e.g., "Routes migrated: execute ✓, list ✓, detail ✓") makes gaps visible to reviewers.
- If a helper exists for "callers without the entry", don't call it when you already have the entry — read the field directly to keep data flow explicit.
- When a TypeScript narrowing cast appears inside an arrow function, bind to a local `const` before the closure rather than casting — it is both safer and clearer.
