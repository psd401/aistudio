---
title: DynamoDB TTL deletion is asynchronous — reader must enforce the expiry window itself
category: database
tags:
  - dynamodb
  - ttl
  - retention
  - agent-platform
  - thread-session-map
severity: medium
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

Added a DynamoDB thread→conversation-session map (`thread-session-map.ts` in both
`agent-cron` and `agent-router` lambdas, issue #1891 / PR #1913) with a `ttl` attribute for
automatic expiry. A PR reviewer (Codex) flagged that an item can still be read back for up to
~48 hours after its TTL timestamp has passed, because DynamoDB's TTL sweeper runs on a lazy
background schedule, not at the exact second the attribute lapses.

## Root Cause

DynamoDB TTL is a best-effort background deletion mechanism, not a hard read-time boundary.
Setting a `ttl` attribute only guarantees *eventual* deletion — it does not prevent
`GetItem`/`Query` from returning an already-"expired" item in the meantime.

## Solution

Store an explicit `expiresAt` (or equivalent) value alongside the TTL attribute, and have the
reader compare `expiresAt` against the current time before trusting the row, even though the
same value also drives the TTL attribute. The TTL attribute is for storage cleanup only;
correctness depends on the application-level check.

## Prevention

- Never treat "has a `ttl` attribute" as sufficient for a retention/visibility bound — grep for
  any DynamoDB table relying on TTL for correctness and verify the reader re-checks expiry.
  Related: [[2026-07-01-idempotency-check-toctou-before-for-update]] for a similar class of
  "the store's own mechanism isn't synchronous — check it yourself" trap.
