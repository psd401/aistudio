---
title: onError on sandboxed iframes is required to distinguish loading from blocked/errored state
category: react-patterns
tags:
  - iframe
  - sandbox
  - onError
  - CSP
  - observability
  - UX
severity: medium
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 2 sandbox iframe had no `onError` handler. When the sandbox CloudFront origin returned a 404 or a CSP `frame-ancestors` header blocked the embed, the user saw a permanently blank frame — visually identical to "still loading." There was no way to distinguish a blocked/errored iframe from one that was initializing normally.

## Root Cause

Browser iframes do not surface CSP violations, network errors, or 404s to the parent frame via any DOM event that fires reliably across browsers. The `onError` event on the `<iframe>` element is the only hook available in React for detecting load failures at the element level. Without it, all failure modes appear as a blank frame.

## Solution

```tsx
<iframe
  key={selectedVersionId}
  src={sandboxSrc}
  sandbox="allow-scripts"
  onLoad={() => setFrameState('ready')}
  onError={() => setFrameState('error')}
  title="artifact-sandbox"
/>
```

When `frameState === 'error'`, render an explicit error notice explaining that the artifact could not be loaded (and whether to retry or report).

## Prevention

Any iframe that renders dynamic/external content must have both `onLoad` and `onError` handlers. "No event fired" is not the same as "loaded successfully." Distinguish the three states: loading, ready, error.
