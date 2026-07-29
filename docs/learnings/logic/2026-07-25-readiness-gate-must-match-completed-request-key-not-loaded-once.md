---
title: A readiness gate for a consequential action must track the completed request's key, not a "loaded once" latch
category: logic
tags:
  - async-state
  - race-condition
  - ui-gating
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

A destructive/consequential action (in this case a publish/visibility control) was
enabled once client state had "loaded" — a boolean latch set true after the first
successful fetch. On a refresh (e.g. switching documents), the latch stayed true
from the prior load while new data was still in flight, leaving the control
enabled against stale data.

## Root Cause

Readiness was modeled as "have we ever loaded data" instead of "does the data we
have correspond to the thing currently being acted on." A boolean latch can't
express that distinction.

## Solution

Gate readiness on comparing the key that produced the current data (e.g. document
id) against the key currently being requested/displayed. Only enable the action
when they match.

## Prevention

- For any control whose safety depends on fresh data, don't use a one-time
  "loaded" boolean — compare the request key against the currently-displayed key
  so a refresh correctly disables the control until the matching response lands.
