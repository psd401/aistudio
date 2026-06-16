---
title: "Importing jest from @jest/globals disables jest.mock hoisting"
category: test-failures
tags:
  - jest
  - jest.mock
  - hoisting
  - "@jest/globals"
  - eslint-complexity
  - no-for-each
  - advisory-lock
  - catalog
  - mcp
  - boot-sync
severity: high
date: 2026-06-16
source: auto — /work
applicable_to: project
---

## What Happened

During #924 (unified tool catalog), a test used `import { jest } from "@jest/globals"`. The mocks appeared to be set up correctly but the handler returned real output and mock call counts were always 0 — silent failure with no error thrown.

## Root Cause

`jest.mock()` hoisting is performed by babel-jest as a compile-time transform: it rewrites the file so `jest.mock(...)` calls are physically moved above all `import` statements. This only works when `jest` is the implicit global. When you `import { jest } from "@jest/globals"`, babel-jest treats it as a named import — it cannot hoist the call, so the mock runs *after* the real module has already been imported and bound.

## Solution

Remove `import { jest } from "@jest/globals"` and rely on the global `jest` object. babel-jest then hoists `jest.mock()` above the imports as intended, and mocks intercept the real module load.

## Prevention

- Do not import `jest` from `@jest/globals` in any file that calls `jest.mock()`.
- If you need explicit typing for `jest` globals, use `/// <reference types="jest" />` or configure `@types/jest` instead of the named import.
- When a mock shows 0 call count and the handler returns real values, check for this import pattern first — it is a silent failure with no thrown error.
