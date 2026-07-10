---
title: Additive fail-closed flag, E2E existence-masking, SSRF allowlist, ElastiCache auth via CfnReplicationGroup
category: security
tags:
  - pr-review
  - atrium
  - guardrails-fail-closed
  - existence-masking
  - ssrf
  - elasticache-auth
  - cdk
  - yjs-collab
  - scoped-fix
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1062 (Atrium Phase 1 collab) round-6 review surfaced four independent security findings:

1. **Guardrails fail-open was a pre-existing global behavior** — changing it would break chat callers that depend on fail-open. The strict call site (collab endpoint) needed fail-closed *without* touching the shared path.
2. **Reader page returned 403 for unauthorized access** — leaking doc existence; should be 404. E2E specs had encoded the buggy 403 and needed updating alongside the fix.
3. **COLLAB_INTERNAL_URL** accepted arbitrary destinations before sending a signed JWT — SSRF risk.
4. **ElastiCache AUTH token + at-rest encryption** were required but `CfnCacheCluster` cannot express either; the CDK construct needed migration to `CfnReplicationGroup`.

## Root Cause

1. Shared guardrails helper was designed fail-open so chat degradation is graceful. New collab endpoint needed stricter behavior but was a strict *call site*, not the right place to change global policy.
2. Authorization checks on reader page ran before existence checks — classic 403-before-404 IDOR pattern (same root as [[existence-leak-via-403-before-404]] but at a different layer). E2E specs written against the buggy behavior became a second failure point.
3. No validation of `COLLAB_INTERNAL_URL` against an allowlist before including a signed JWT in the request — any env var value or future misconfiguration becomes an SSRF vector.
4. `CfnCacheCluster` is ElastiCache's legacy single-node construct; AWS deliberately withholds `authToken` and `atRestEncryptionEnabled` from it. Only `CfnReplicationGroup` exposes both, even for a single-node deployment.

## Solution

1. Added an additive `degraded` discriminator flag to the guardrails return type. Strict callers opt-in by checking `result.degraded` and treating it as a hard failure. Fail-open callers ignore the flag — no behavior change.
2. Flipped reader page to 404-on-unauthorized. Grepped and updated all E2E specs that asserted the old 403 *before* deploying the fix.
3. Added a `COLLAB_INTERNAL_URL_ALLOWLIST` env-var check; request is rejected if the resolved URL does not match an allowed prefix.
4. Replaced `CfnCacheCluster` with `CfnReplicationGroup` (`numCacheClusters: 1`, `automaticFailoverEnabled: false`) — the minimal construct that accepts `authToken` and `atRestEncryptionEnabled`.

## Prevention

- When a reviewer flags shared pre-existing behavior (fail-open guardrails, permissive defaults) **that is outside the PR diff**: add an additive opt-in flag at the strict call site; never change global behavior other callers depend on.
- When flipping an API contract (403→404, any status code change): **grep tests first** — E2E specs frequently encode the buggy behavior and must be updated in the same PR.
- Any code path that sends a credential (JWT, signed token) to a URL derived from config or user input needs an allowlist before the outbound call.
- `CfnCacheCluster` cannot express ElastiCache AUTH or at-rest encryption. Use `CfnReplicationGroup` with `numCacheClusters: 1` and `automaticFailoverEnabled: false` for single-node clusters that need security features.
- Y.Doc instances must call `.destroy()` in cleanup; uncleaned docs leak listeners and memory across WebSocket sessions.
