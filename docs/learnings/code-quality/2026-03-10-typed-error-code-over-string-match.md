---
title: Typed ErrorCode check always beats error.message string matching
category: code-quality
tags:
  - error-handling
  - type-safety
  - typed-errors
  - ErrorFactories
severity: high
date: 2026-03-10
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #840 review found `error.message` string-match guards used to detect specific error conditions in API routes, despite the codebase having a typed `ErrorCode` enum and `ErrorFactories` infrastructure.

## Root Cause

Developers fell back to `error.message.includes("some phrase")` pattern because it is immediately readable. When typed error infrastructure exists but is not enforced by lint or convention, ad-hoc string matching silently competes with it.

## Solution

Check the typed property instead: `error.code === ErrorCode.SomeCode` (or equivalent typed discriminant).
Replace `new Number()` / `Number()` raw conversions with the project helper `getUserIdByCognitoSubAsNumber`, which includes a NaN guard.
Consolidate duplicated error-switch blocks across routes into `handleError()`.

## Prevention

- When reviewing any `catch` block that inspects `error.message`, flag it as wrong — always use the typed `code` property.
- String-match on error messages has two failure modes: (1) swallows real errors whose message coincidentally matches; (2) silently breaks when the message template changes.
- Enforce via code review checklist: "Does this project have a typed error enum? Then no `error.message` string matching."
