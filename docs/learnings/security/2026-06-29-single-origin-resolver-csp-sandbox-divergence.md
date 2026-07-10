---
title: Split origin resolvers silently diverge — one logical value needs one resolver
category: security
tags:
  - pr-review
  - sandbox
  - csp
  - origin-validation
  - single-source-of-truth
  - edge-runtime
  - dead-code
  - react-key
  - sibling-asymmetry
  - atrium
severity: high
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1069 (Atrium Phase 2 artifact canvas + cross-origin sandbox) shipped three instances of the same class of bug: a logical value (the artifact sandbox origin) was resolved by more than one code path, and those paths diverged in priority or validation logic.

1. **middleware.ts** had a local sandbox-origin resolver reading env vars in OPPOSITE priority order from the shared app config (`ATRIUM_` first vs `NEXT_PUBLIC_` first). A mixed env would allowlist origin A in CSP `frame-src` while the iframe `src` pointed at origin B — silently blocked frame.
2. **CDK normalizer** omitted the `http(s)://` protocol guard the app config had. `ftp://` (non-null, unlike opaque `file://`) would bake into the CSP. The CDN allowlist also bypassed the normalizer entirely.
3. **listVersionsAction** lacked the `obj.kind === 'artifact'` guard that the sibling `getArtifactCodeAction` had, letting a viewer enumerate a document's version provenance via an artifact-only action (information leak, not authz bypass).

## Root Cause

Shared config helpers were not imported where new code paths needed the same value. Each new entry point re-implemented the logic from memory, diverging in priority order, protocol validation, and kind guards.

## Solution

- Import `getArtifactSandboxOrigin()` (Edge-Runtime safe: URL + process.env only) in middleware.ts instead of re-implementing the resolver.
- Ensure the CDK normalizer calls the same protocol-stripping + re-prefixing logic as the app config; the CDN allowlist must pass through the normalizer too.
- Add `obj.kind === 'artifact'` guard to `listVersionsAction` matching the sibling `getArtifactCodeAction` pattern.

## Prevention

- Treat any value that appears in both a CSP header and a runtime URL as a single-source-of-truth candidate. If it isn't served by one function, make it one.
- During PR review: for each new action, grep for the sibling action and diff its auth/kind guards.
- **Dead code signal**: a React `key={id}` remounts a component on every ID change, making any in-place `useEffect` re-post path (guarded by `loadedRef`) permanently dead code (ref is always false on fresh mount). Pick one mechanism — `key` remount OR ref-gated re-post — and delete the other.
