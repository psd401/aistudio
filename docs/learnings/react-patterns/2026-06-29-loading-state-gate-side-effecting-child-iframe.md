---
title: Gate side-effecting child render on ready state, not just non-error state
category: react-patterns
tags:
  - react
  - iframe
  - sandbox
  - loading-state
  - race-condition
  - server-actions
  - error-handling
  - atrium
severity: medium
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

In `components/atrium/ArtifactCanvas.tsx`, the preview branch rendered `<ArtifactSandbox>` whenever `state !== "error" && tab === "preview"`. During the initial loading state the sandbox mounted with `key=""` and `code=""`. The iframe's `onLoad` fired before `loadCode` resolved, posting an empty `atrium-render` message that flashed a blank frame. Separately, `handleSelectVersion` awaited `loadCode` without a try/catch, so a network or non-2xx failure from the Next.js server action threw past the result-shape handler and left the canvas stuck in "loading" indefinitely.

## Root Cause

Two independent gaps:

1. **Loading-state guard missing**: The render condition only excluded the error state, so the side-effecting child (`<ArtifactSandbox>`) mounted during loading with empty props. The iframe's `onLoad` event is a browser-native callback that fires as soon as the document is ready — it does not wait for React state updates.

2. **Server-action infrastructure throws, not returns**: The `loadCode` helper handles `isSuccess: false` result shapes, but Next.js server-action infrastructure itself throws on non-2xx responses or network failures before the helper ever sees the result. An async event handler (e.g., `handleSelectVersion`) that calls a server action must have its own try/catch for this layer.

## Solution

1. Add an explicit `state === "loading"` branch that renders a stable-height `aria-busy` placeholder div instead of `<ArtifactSandbox>`. Only render the sandbox when `state === "ready"` (or equivalent non-loading, non-error state).

2. Wrap the `await loadCode(...)` call in `handleSelectVersion` with a try/catch that transitions state to `"error"` on throw, mirroring the guard already present in the initial `useEffect`.

```tsx
// Before — races during loading
{state !== "error" && tab === "preview" && (
  <ArtifactSandbox key={versionId} code={code} />
)}

// After — loading gets placeholder, sandbox only mounts when ready
{tab === "preview" && state === "loading" && (
  <div aria-busy="true" style={{ minHeight: CANVAS_HEIGHT }} />
)}
{tab === "preview" && state === "ready" && (
  <ArtifactSandbox key={versionId} code={code} />
)}
```

## Prevention

- Any component that mounts a child with side-effecting lifecycle callbacks (iframe onLoad, WebSocket, canvas context) must gate the mount on a fully-resolved ready state, not just the absence of an error state.
- Every async event handler that calls a server action needs its own try/catch for the infrastructure-throw layer, even if the action helper normalizes the result shape internally.
