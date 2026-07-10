---
title: Verify reviewer security claims against pinned deps; use globalThis hooks for cross-bundle shutdown
category: security
tags:
  - pr-review
  - xss
  - hast-util-sanitize
  - false-positive-verification
  - sigterm-graceful-shutdown
  - globalThis-hook
  - esbuild-bundle-module-instance
  - yjs-crdt
  - websocket-error-listener
  - env-var-zero-parsing
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1062 (Atrium Phase 1 collab) Round 9 review surfaced a claimed "critical XSS" blocker: reviewer stated `hast-util-sanitize defaultSchema` has no `src` protocol restriction on `img` tags, meaning `data:` / `javascript:` URIs would pass through. Separately, SIGTERM was identified as abandoning an in-flight collab persist debounce. Two real issues required careful solutions; one security claim required verification before any change.

## Root Cause

**False positive**: The reviewer's claim about `hast-util-sanitize` was based on an outdated or incorrect understanding. The installed pinned version of `hast-util-sanitize` DOES restrict `img src` to `http/https` protocols in its `defaultSchema`. A smoke test confirmed `data:` and `javascript:` URIs are stripped.

**Real P1 — WebSocket error listener**: `ws.on('error', ...)` was registered after `await` expressions in the setup path, creating a window where an `ERR_UNHANDLED_ERROR` could crash the task.

**Real P2 — SIGTERM / cross-bundle shutdown**: Production collab runs in a separate esbuild bundle. A direct ES module import of the collab state map from the Next.js source module would yield a DIFFERENT module instance (different in-memory Map). SIGTERM on the Next.js process cannot directly reach the esbuild bundle's in-memory state via import.

## Solution

- **False positive**: Ran smoke test against installed `hast-util-sanitize` before touching any code. Confirmed data:/javascript: URIs are stripped. Did NOT implement the reviewer's suggested fix.
- **ws.on('error')**: Hoisted error listener registration to before any `await` in the WebSocket setup function.
- **SIGTERM cross-bundle shutdown**: Registered a `globalThis.__collabShutdown` hook from within the esbuild bundle. The surviving SIGTERM handler (in `instrumentation.ts`) awaits `globalThis.__collabShutdown?.()` rather than importing the collab module directly. This correctly reaches the bundle's actual in-memory state.
- **Bonus fix**: Replaced `Number(env) || default` patterns with strict IIFE parse — `Number(env) || default` silently treats an explicit `0` as falsy, substituting the default when the intent was `0`.

## Prevention

- Before fixing a reviewer-flagged security issue, verify the claim against the actual installed (pinned) dependency version. A smoke test is cheap; an unnecessary breaking change is not.
- When a module runs from BOTH a Next.js source path AND a separate esbuild prod bundle, a direct import always gets the source module's instance. Use `globalThis.__hook` registration from the bundle + `await globalThis.__hook?.()` from the SIGTERM handler as the cross-instance coordination pattern.
- Always hoist `ws.on('error', ...)` before any `await` in WebSocket setup to prevent `ERR_UNHANDLED_ERROR` task crashes.
- Use strict env-var parsing: `const val = process.env.FOO !== undefined ? Number(process.env.FOO) : DEFAULT` — never rely on `||` which coerces `0` to falsy.
