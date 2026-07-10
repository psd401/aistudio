---
title: key prop on sandboxed iframe is required for clean version switching
category: react-patterns
tags:
  - iframe
  - key-prop
  - React
  - sandbox
  - version-switching
  - artifacts
severity: medium
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 2 artifact canvas allows switching between document versions. Without `key={selectedVersionId}` on the sandboxed iframe, switching versions only updated the `code` prop and posted a new message into the existing iframe. If the previous version had thrown a JS error or left dirty DOM state, the new version rendered into that contaminated environment.

## Root Cause

React reuses an existing DOM node when the element type and position in the tree are stable. Updating props on a mounted iframe does not remount it — the old execution context (JS globals, error state, any registered event handlers) persists. A `postMessage` into a dirty iframe may be processed by stale event listeners from the previous version.

## Solution

```tsx
<iframe
  key={selectedVersionId}
  src={sandboxSrc}
  sandbox="allow-scripts"
  title="artifact-sandbox"
/>
```

Each unique `selectedVersionId` triggers a full remount, giving each version a clean origin, fresh JS environment, and no residual state. This is the same pattern used by Claude Artifacts and similar canvas UIs.

## Prevention

Any iframe that renders user/AI-controlled content and supports multiple discrete versions or tabs must use `key` tied to the version/slot identity. Never rely on postMessage into a live iframe as a reset mechanism — remount is the spec-correct approach.
