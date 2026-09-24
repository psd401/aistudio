---
title: Explanatory comments can push a function over max-lines-per-function — extract a hook, don't trim the comments
category: code-quality
tags:
  - eslint
  - max-lines-per-function
  - refactoring
  - custom-hooks
severity: low
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1697: adding explanatory comments to `CreateForm` to document the
toast/focus fixes pushed the component past the `max-lines-per-function` (150)
lint cap.

## Root Cause

The lint rule counts comment lines along with code lines; comments added for
future-maintainer clarity count against the same budget as logic.

## Solution

Extracted a `useAssistantImages()` hook to pull cohesive, self-contained logic
(and its comments) out of `CreateForm`, rather than deleting or shortening the
explanatory comments to fit under the cap.

## Prevention

- When a `max-lines-per-function` violation appears after adding comments,
  default to extracting a hook/helper for the commented block — don't trade
  away documentation to satisfy the linter.
