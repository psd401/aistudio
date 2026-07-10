---
title: Before/after usage-delta reads must distinguish "failed" from "genuinely zero"
category: logic
tags: [telemetry, delta-calculation, error-handling, agent-platform]
severity: high
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083 fixed GLM-5 agent token/cost telemetry by reading a cumulative
`/usage` counter from the Mantle proxy (`infra/agent-image/mantle_proxy.py`)
before and after each turn, then taking the delta. A failed baseline read
that silently defaulted to 0 would attribute the container's entire lifetime
token count to a single turn.

## Root Cause

The proxy's cumulative counters are per-container (per-session), so `delta =
after - before` only works if `before` reflects the true state at turn start.
If the baseline HTTP call to `/usage` fails (network blip, race with proxy
startup) and the caller treats "failed" the same as "returned 0", the
subsequent delta massively over-counts — it sums every prior turn's tokens
into the current one.

## Solution

`agentcore_wrapper.py` distinguishes `{ok: false}` (read failed) from a
genuine `0` count. On a failed baseline OR failed final read, it falls back
to the harness's own token accounting instead of computing a delta, and logs
the gap so a lost read is distinguishable from real-zero usage in monitoring.

## Prevention

Any before/after delta computed from an external counter must model read
failure as a distinct state, not coerce it to `0`. Treat `0` as "confirmed
zero", not "unknown" — conflating them turns transient read failures into
large, silent over-counts.
