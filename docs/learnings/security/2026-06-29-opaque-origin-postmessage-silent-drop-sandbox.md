---
title: sandbox="allow-scripts" creates opaque origin — parent.postMessage to a concrete targetOrigin is silently dropped
category: security
tags:
  - iframe-sandbox
  - postMessage
  - opaque-origin
  - cross-origin
  - csp
  - jsdom-test-gap
  - atrium
severity: critical
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

Atrium Phase 2 artifact-preview iframe uses `sandbox="allow-scripts"` (no `allow-same-origin`). The parent page called `iframe.contentWindow.postMessage(msg, "https://concrete.host")` to deliver artifact code. All CI checks (typecheck, lint, smokes, cdk synth) passed green. The feature was silently broken in production — no error surfaced anywhere.

## Root Cause

When `sandbox="allow-scripts"` is set WITHOUT `allow-same-origin`, the framed document runs under an **opaque origin** (serialized as `"null"`). The `postMessage` algorithm compares the message's `targetOrigin` against the recipient frame's origin. An opaque origin never matches any concrete origin string — the message is silently dropped with no error, no event, no warning. jsdom-based smokes cannot catch this because jsdom does not enforce opaque-origin postMessage semantics.

## Solution

Use `targetOrigin "*"` when the recipient frame has an opaque origin. Authenticate the sender inside the framed page instead: check `event.origin` in the `message` listener against an allowlist of known host origins (the allowlist already existed in the artifact viewer). This preserves isolation — the iframe still cannot access the parent's DOM or storage — while making delivery reliable.

## Prevention

- Any `postMessage` into a sandboxed iframe: verify whether `allow-same-origin` is absent. If so, the frame is opaque — use `"*"` as targetOrigin and authenticate via `event.origin` on the receiver side.
- Never rely on jsdom smokes to validate cross-origin postMessage delivery. A real-browser E2E test (Playwright) or manual smoke is required.
- Secondary pattern: a cancel-token ref incremented inside a helper (`loadCode`) must NOT be captured and passed to a concurrent sibling operation (`refreshVersions`). The helper's own increment makes the captured token instantly stale, silently dropping the sibling's result. One cancel token = one owner.
