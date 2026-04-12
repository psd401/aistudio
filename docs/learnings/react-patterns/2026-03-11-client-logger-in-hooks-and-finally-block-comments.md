---
title: Use client-logger in hooks for production visibility; comment redundant assignments before early returns in try/finally
category: react-patterns
tags:
  - use-action
  - client-logger
  - trailing-newline
  - finally-block
  - code-clarity
severity: low
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

During PR #845 review (fix/837-polling-session-errors), a stale-bundle detection path in `useAction` initially used `console.warn` for observability. CLAUDE.md prohibits all `console.*` — the fix was replacing it with `createLogger` from `@/lib/client-logger`. A separate finding: redundant `isLoadingRef.current = false` assignments in 401 early-return branches inside a `try/finally` caused reviewer confusion — the `finally` always runs, making those assignments technically redundant, but they were intentional belt-and-suspenders.

## Root Cause

- Habit of reaching for `console.warn` for one-off or detection-only log paths in hooks.
- Redundant state resets before early returns look like copy-paste bugs without an explanatory comment; reviewers flag them for removal, which is wrong.

## Solution

- Replace all `console.warn/log/error` in hooks with `createLogger` from `@/lib/client-logger`, even for infrequent detection paths.
- Add an inline comment on redundant assignments before early returns in `try/finally` blocks: `// belt-and-suspenders: finally always runs, but explicit here for clarity`.

## Prevention

- Lint rule already catches `console.*` — don't suppress, fix.
- When writing `try/finally`, if a state reset appears both in an early-return branch AND in `finally`, add a comment on the early-return instance explaining intent. This prevents future readers from removing it as dead code.
