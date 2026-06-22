---
title: Jest fails at transform time when a module transitively imports ESM-only packages via MCP connector
category: integration
tags:
  - jest
  - esm
  - mcp
  - jest-esm
  - transformIgnorePatterns
  - mock-hoisting
  - agentic
  - 926
severity: high
date: 2026-06-17
source: auto — /lfg
applicable_to: project
---

## What Happened

Unit tests for the agent runtime (issue #926) failed at transform time with `Unexpected token export`. The root cause was a transitive import chain: SUT → `lib/mcp/connector-service` → `@ai-sdk/mcp` → `pkce-challenge` (ESM-only package not in `transformIgnorePatterns`). Jest's CommonJS transform cannot handle it.

A second related trap: importing `jest` from `@jest/globals` in the same file disables mock hoisting, so `jest.mock()` calls no longer run before imports. This caused `jest.requireMock()` to return the real module instead of the mock.

## Root Cause

1. `pkce-challenge` is ESM-only and not listed in `transformIgnorePatterns`, so any file that statically imports it (even transitively) breaks Jest's transform.
2. `import { jest } from '@jest/globals'` opts the file out of Babel's automatic mock-hoisting transform. This is a known Jest ESM compatibility shim that has a side effect: `jest.mock()` at module scope no longer runs before static imports.

## Solution

1. Changed the SUT to lazy-import `connector-service` inside function bodies rather than at the top of the module. This removes the transitive ESM dependency from the static import graph at test time.
2. Retrieved the mock via `jest.requireMock('../../lib/mcp/connector-service')` instead of a static import in the test file, so hoisting order does not matter.
3. Removed `import { jest } from '@jest/globals'` and used the globally-available `jest` object instead.

## Prevention

- Do not statically import `lib/mcp/connector-service` (or any file that pulls in `@ai-sdk/mcp`) in files that must be unit-tested with Jest. Use lazy imports for that dependency.
- Never use `import { jest } from '@jest/globals'` in test files that also use `jest.mock()` — the two are mutually exclusive in the current Jest setup.
- When a test fails with `Unexpected token export`, the root cause is almost always an ESM package not in `transformIgnorePatterns`. Resolve by lazy-importing rather than extending the patterns list (the list grows unbounded otherwise).
