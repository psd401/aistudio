---
title: bun-types triple-slash directive pollutes tsc program and breaks DOM-typed tests
category: build-errors
tags:
  - lfg
  - autonomous
  - atrium
  - bun
  - tsc
  - types
  - codeql
  - csp
  - iframe-sandbox
  - cross-origin
  - codemirror
  - cdk
  - postMessage
severity: high
date: 2026-06-29
source: auto — /lfg
applicable_to: project
---

## What Happened

During Atrium Phase 2 (/lfg autonomous run, issue #1052), a Bun smoke test file inside the tsc `include` glob (`**/*.ts`) contained `/// <reference types="bun-types" />`. This injected Bun's global type definitions into the entire tsc compilation, overriding the DOM global `fetch` type. Unrelated DOM-typed tests (e.g. `web-fetch.test.ts`) began failing with `Property 'preconnect' is missing` because the Bun `fetch` type does not include `preconnect`.

A second issue was caught by a jsdom host-page smoke: `String.replace(token, value)` only substitutes the FIRST occurrence. The CDK stack used `.replace('__CSP_POLICY__', ...)` but the token appeared in both an HTML comment and the live `<meta>` attribute — the live attribute shipped unsubstituted.

## Root Cause

1. **Triple-slash bypass**: `/// <reference types="bun-types" />` bypasses the `types: [...]` allowlist in tsconfig. Even when `@types/bun` is absent from `package.json` or excluded from tsconfig `types`, the directive force-includes Bun globals into every file in the program.
2. **String.replace first-match only**: The deploy-time token substitution used `replace()` (first-occurrence) on an HTML template that had the same token in two places — a comment and the live CSP meta tag. The comment consumed the replacement; the attribute remained a literal placeholder.

## Solution

1. Remove `/// <reference types="bun-types" />` from any file matched by tsconfig `include`. Bun provides globals at runtime via `bun run` — the reference is never needed for execution. Use `process.cwd()` (run from repo root) instead of `import.meta.dir` for path resolution in Bun smoke files.
2. Drive component fail-closed branches via env-var control rather than `bun:test` mock.module (avoids needing bun-types in scope).
3. Change `.replace(token, value)` → `.replaceAll(token, value)` for all deploy-time HTML token substitution. De-duplicate template tokens to one canonical location.

## Prevention

- Never add `/// <reference types="bun-types" />` (or any ambient reference) to a file matched by `tsconfig.json` include globs.
- For any deploy-time HTML template substitution, use `replaceAll` and write a jsdom smoke that asserts no literal placeholder strings survive in the rendered output.
- A jsdom host-page smoke is a cheap and effective guard for CDK-generated static HTML assets (CSP headers, OAC configuration, token substitution).
