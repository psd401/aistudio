---
title: Separate "the side effect succeeded" from "recording it succeeded" — a telemetry write failing after a successful send must not retry the send
category: logic
tags: [agent-schedules, retry, telemetry, error-handling]
severity: medium
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

In the router's deferred-delivery retry path (#1890), a telemetry write
that threw AFTER the Chat post had already succeeded fell into the same
catch block as a genuinely failed post. On the final retry attempt, this
recorded "never succeeded" for a message the owner was already reading in
Chat.

## Root Cause

One try/catch covered two operations with different failure semantics: the
Chat post (the thing that must eventually succeed, worth retrying) and the
telemetry write (bookkeeping about the Chat post, not worth retrying once
the post landed). Catching both in one block meant a telemetry failure
masqueraded as a delivery failure and could trigger a repeat send of a
message that had already reached the owner.

## Solution

Track delivery success in its own flag, set immediately after the Chat post
is confirmed accepted. Once that flag is true, a subsequent telemetry-write
exception is logged but does not flip the run back to "retry" — there is
nothing left to retry once the side effect the retry exists for has already
landed.

## Prevention

- When a retry loop wraps multiple steps, isolate the step whose success
  defines "done" (the side effect) from steps that merely record it
  (telemetry, audit, status columns). Only the former should control
  whether the loop retries.
- A single catch block around "do the thing" + "record that I did the
  thing" will, on the record step's failure, misreport the thing as
  unfinished.
