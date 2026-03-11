---
title: "@assistant-ui upgrade type breaks — exhaustive switch and generic constraint tightening"
category: frontend
tags:
  - assistant-ui
  - streaming
  - argsText
  - tool-ui
  - dependency-upgrade
  - error-boundary
  - typescript
severity: medium
date: 2026-03-04
source: auto — /work
applicable_to: project
---

## What Happened

Upgraded `@assistant-ui/react-ai-sdk` from 1.3.3 to 1.3.11. The package ships `stableStringifyToolArgs` (v1.3.11) which fixes key-order instability in tool args serialization during streaming — the root fix for `argsText` invariant violations. Two TypeScript breakages appeared on upgrade:

1. Attachment type union was widened (no longer a closed union) — an exhaustive `never` check on the attachment type switch statement broke at compile time.
2. `MessageFormatAdapter` generic constraint was tightened — `TStorageFormat` now requires `Record<string, unknown>`, breaking usages that passed a narrower or unrelated type.

`ToolArgsRecoveryBoundary` was also added as a defense-in-depth error boundary around all tool UI rendering paths.

## Root Cause

- **Exhaustive switch break**: Library widened a discriminated union to be string-extensible. Exhaustive switches that fell through to a `never` check became invalid once the union is open-ended.
- **Generic constraint tightening**: `MessageFormatAdapter<TStorageFormat>` added `Record<string, unknown>` as a constraint on `TStorageFormat`. Any adapter with a storage type that didn't satisfy that constraint (e.g., a plain string or narrower interface) failed.

## Solution

- Replace `never` exhaustive checks on assistant-ui type unions with a `default` case (log/throw a runtime error instead of relying on compile-time exhaustion).
- Add `Record<string, unknown>` (or `& Record<string, unknown>`) to adapter storage format types to satisfy the tightened constraint.
- Wrap all tool UI rendering paths with `ToolArgsRecoveryBoundary` so streaming parse errors degrade gracefully rather than crashing the chat view.

## Prevention

- When upgrading `@assistant-ui/*`, audit all exhaustive switches on library-owned union types — use `default` cases instead of `never` checks.
- Check `MessageFormatAdapter` generic constraints after any upgrade; the storage format type must satisfy `Record<string, unknown>`.
- Pin `stableStringifyToolArgs` usage to v1.3.11+ as the canonical fix for argsText key-order drift during streaming.
- Always add `ToolArgsRecoveryBoundary` around tool UI rendering as a standard pattern.
