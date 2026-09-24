---
title: Adding a queue in front of a timed operation needs a pre-dispatch budget that outlasts worst-case queue wait
category: performance
tags: [queueing, timeout, concurrency-limit, self-review]
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Self-review of #1788 found: replacing a hard in-flight cap of 8 (which rejected the 9th request) with a concurrency limit of 6 + a bounded FIFO queue (`components/atrium/ArtifactSandbox.tsx`) broke the existing 45s query timeout. With 26 queued behind 6 concurrent slots (32 total, matching the sandbox host's own `MAX_PENDING_DATA_REQUESTS`), a tail request could wait up to `ceil(32/6) = 6` dispatch waves before even starting. The 45s clock (originally meant to bound execution time) started at enqueue, so tail requests timed out before dispatch — then got dispatched anyway, ran a real MCP+RDS query burning a rate-limit slot, and had their answer discarded.

## Root Cause

A dispatch-ack that re-arms a timeout can only rescue a request that is STILL PENDING when the ack arrives. If the pre-dispatch queue wait can itself exceed the timeout, the timeout fires before dispatch, and re-arming logic never gets a chance to run — the request proceeds anyway because the queue doesn't know to cancel it, wasting server-side work and rate-limit budget for a result nobody will see.

General lesson: when adding a queue in front of work that already had a timeout, the pre-dispatch budget must outlast the worst-case queue wait, or the queue reintroduces the exact failure (timeout on a well-behaved but slow-to-start request) it was meant to fix.

## Solution

Split the timeout into two phases: a queue-tolerant pre-ack budget of 315s (covers the worst-case queue wait of 6 dispatch waves), applied to EVERY op rather than only queries, which resets to the real 45s server-execution budget once `atrium-artifact-data-ack` confirms dispatch. Also added the ack event itself (`infra/sandbox-host/render.html` restarts its query clock at DISPATCH, not at post time) so the client's clock and the server's clock agree on when work actually started.

## Prevention

- When introducing or widening a queue/concurrency limiter in front of previously-direct calls, compute worst-case queue wait (`ceil(queueDepth / concurrency) * avgSlotDuration`) and compare it against any existing timeout on that path.
- If a dispatch-ack pattern is used to re-arm timeouts, verify the pre-ack timeout can never fire while a request is legitimately still queued (not yet dispatched).
- Apply the pre-dispatch budget to EVERY operation the queue accepts, not just the slow one you were thinking about. The first version of this fix covered only queries; a later review found that a queued `submit` still had its bare 10s budget, so it could be rejected locally and then dispatched anyway — the write landed after the caller was told it failed, and a retry created a duplicate record.
- Reconcile the capacity of the two layers explicitly. A parent counting "queued behind the active slots" and a frame counting "every promise held open" do NOT agree just because both say 32: derive one from the other (here `queue = hostPending - concurrency`) or the advertised capacity is unreachable.
