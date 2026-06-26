---
title: next/jest (SWC) cannot transform pure-ESM node_modules — isolate ESM, verify with Bun
category: testing
tags:
  - jest
  - next-jest
  - esm
  - unified
  - remark
  - rehype
  - transformIgnorePatterns
  - bun
  - atrium
severity: medium
date: 2026-06-26
source: manual — #1051 Atrium Phase 1 render pipeline
applicable_to: project
---

## What Happened

Upgrading `lib/content/render/markdown-render.ts` to the unified/remark/rehype
pipeline broke the one jest test that imported the real module:
`SyntaxError: Unexpected token 'export'` at `node_modules/unified/index.js`. Adding
the whole unified ecosystem to `transformIgnorePatterns` (the documented fix) did
**not** help — even with `--no-cache`.

## Root Cause

This project uses `next/jest` (Next 16, SWC, no Babel). `next/jest` force-ignores
`node_modules` for transformation, so `transformIgnorePatterns` is effectively
inert for ESM-only packages. The pure-ESM unified stack therefore cannot be loaded
by jest at all.

## The Fix

Don't fight the transformer — keep ESM-only code out of jest's import graph:

1. Split the jest-testable part into its own module with no ESM imports. Here,
   `sanitizeHtml` (DOMPurify, CJS-friendly) moved to `render/html-sanitize.ts`, so
   its 49 security tests still run under jest; `renderMarkdownToHtml` (unified)
   stayed in `markdown-render.ts`.
2. Any test that transitively reaches the ESM module must `jest.mock()` it (the
   version-service tests already mocked `markdown-render`, so they were unaffected).
3. Verify the real ESM pipeline with a **Bun** smoke test (`bun run …smoke.ts`) —
   Bun executes ESM + TS natively. jest's default `testMatch` ignores `*.smoke.ts`,
   so the two runners don't collide.

## Watch Out

- A re-export pulls the re-exported module into every consumer's bundle. Re-exporting
  `sanitizeHtml` (jsdom) from `markdown-render` dragged jsdom into the **esbuild
  collab handler bundle** (12.8MB → 7.0MB after removing the dead re-export). Keep
  heavy/optional deps out of re-export chains that server bundles import.
- The same "isolate + Bun-smoke" pattern applies to any future pure-ESM dep
  (TipTap/Yjs in `lib/content/collab/*` are likewise covered by Bun smokes, not jest).
