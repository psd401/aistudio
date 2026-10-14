---
title: A best-effort side write inside the delivery try/catch gets caught and re-queues an already-delivered message
category: architecture
tags:
  - durable-outbox
  - agent-router
  - agent-cron
  - idempotency
  - dynamodb
  - error-handling
severity: high
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

Implementing thread→conversation-session mapping (issue #1891 / PR #1913), the mapping
`PutItem` (a best-effort side write, not required for the Chat post to succeed) was initially
placed inside the same try/catch block as the message delivery call.

## Root Cause

If the `PutItem` throws (throttling, transient DynamoDB error, etc.) after the Chat message has
already been posted, the surrounding try/catch treats it identically to a delivery failure. The
durable outbox then re-queues the "failed" delivery and retries it — but the Chat post already
succeeded, so the retry sends a duplicate post. The side write's failure mode silently
piggybacks on the delivery's retry semantics even though the two operations have nothing to do
with each other.

## Solution

Move best-effort/non-critical side writes (telemetry, mapping tables, analytics) outside the
delivery try/catch, with their own isolated try/catch that logs-and-swallows. Delivery success
must not be retried because of an unrelated side effect's failure.

## Prevention

- Before adding any side write next to a durable-outbox delivery call, ask "if this throws,
  does success of the primary action still hold?" If yes, give it its own try/catch, never
  share the delivery's.
