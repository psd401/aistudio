---
title: Streaming APIs with graceful degradation must surface partial failures to the client
category: ux-patterns
tags:
  - mcp
  - streaming
  - error-handling
  - headers
severity: medium
date: 2026-02-19
source: auto — /work
applicable_to: project
---

## What Happened

Issue #781 added MCP reconnect UX. The server already used `Promise.allSettled` to fetch MCP connector tools, silently dropping failed connectors and continuing the stream. Users had no indication that some tools were unavailable.

## Root Cause

Graceful degradation via `Promise.allSettled` is correct for resilience, but without a feedback channel the client treats partial failure the same as full success. Users see a working chat but missing tools, with no way to diagnose the problem.

## Solution

Added an `X-Connector-Reconnect` response header containing a comma-separated list of failed server IDs. The client reads this header after the stream starts and shows a toast prompting reconnect. Implementation in `/app/api/chat/route.ts` (server) and `/components/nexus/` (client toast).

## Prevention

Whenever using `Promise.allSettled` (or equivalent) in a streaming or SSE response:
1. Collect the rejected items after settling.
2. Surface them via a response header, SSE event, or trailer before/during the stream.
3. Do not treat "stream started successfully" as "all dependencies healthy."
