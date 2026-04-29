---
title: SSE terminal-state events must update UI state defensively — never rely on a follow-up event
category: streaming
tags:
  - streaming
  - sse
  - react-state
  - defensive-programming
severity: high
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

A `warning` SSE event signaled that the model had finished generating, but the handler only logged the warning and left loading state unchanged. A subsequent `finish` event was expected to clear the spinner. When `finish` was dropped or out-of-order, the UI was stuck in a permanent loading state.

## Root Cause

The handler assumed the SSE protocol would always deliver a `finish` event after `warning`. Multi-event protocols do not guarantee delivery order or completeness under network degradation or early stream termination.

## Solution

When any SSE event semantically implies a terminal state (model done, error, cancelled), that event's handler must unconditionally update the relevant UI state — do not delegate to a later event. In the `warning` handler: set `isLoading = false` and mark the model complete before returning.

## Prevention

For any multi-event SSE protocol, map each event to its implied state transitions and ask: "if no further events arrive after this one, is the UI left in a broken state?" If yes, the handler is incomplete. Treat each terminal-adjacent event as potentially the last one.
