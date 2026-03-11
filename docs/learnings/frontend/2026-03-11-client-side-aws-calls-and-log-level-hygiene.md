---
title: Client-side AWS calls always fail — route through server; expected errors belong at warn
category: frontend
tags:
  - sse
  - streaming
  - cloudwatch
  - error-handling
  - logging
severity: high
date: 2026-03-11
source: auto — /work
applicable_to: project
---

## What Happened

Client-side code was publishing metrics directly to CloudWatch. Every call silently failed because browser JS has no AWS credentials. Separately, `ContentSafetyBlockedError` was logged at `error` level in route handlers, inflating error counts in monitoring for expected application behavior.

## Root Cause

- CloudWatch SDK calls from browser context: no IAM credentials available in the browser; calls always reject silently or throw.
- Log level mismatch: content safety blocks are expected outcomes of guardrail policy, not unexpected failures. Logging them at `error` treats normal behavior as incidents.

## Solution

- Removed client-side CloudWatch publishing entirely. Route any client-initiated metrics through a server-side API endpoint that has IAM access.
- Downgraded `ContentSafetyBlockedError` from `log.error` to `log.warn` in all affected route handlers.

## Prevention

- Any AWS SDK import in a `components/` or client-boundary file is a red flag — AWS SDK clients require credentials unavailable in the browser.
- When adding `catch` blocks, ask: "Is this a genuinely unexpected failure, or an expected application state?" Expected states (rate limits, content blocks, not-found) → `warn`. Unexpected failures → `error`.
