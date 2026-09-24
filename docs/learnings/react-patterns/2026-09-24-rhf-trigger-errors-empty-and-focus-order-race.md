---
title: react-hook-form — errors read right after trigger() are empty; built-in focus race beats manual setFocus
category: react-patterns
tags:
  - react-hook-form
  - form-validation
  - focus-management
  - assistant-architect
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1697: Assistant Architect create page's "Add Field"/"Continue" buttons
appeared dead after model selection. Two react-hook-form races masked the real
validation errors during the fix.

## Root Cause

1. `form.formState.errors` read synchronously right after `await form.trigger()`
   is empty — the `formState` proxy subscription hasn't caught up yet — so every
   blocked submit collapsed to a generic fallback message instead of the real
   field error.
2. RHF's built-in `_focusError()` walks fields in **registration order** and
   runs **after** the `onInvalid` callback (twice — once sync, once via
   `setTimeout`). A manual `setFocus()` call made inside `onInvalid` always
   loses that race. If app code separately reports "the first error" in
   **schema order**, the toast names a different field than the one that
   actually receives focus.

## Solution

- Get errors from `handleSubmit(onValid, onInvalid)`'s `onInvalid` callback
  parameter, never from `form.formState.errors` read immediately after
  `trigger()`.
- Set `shouldFocusError: false` in `useForm()` so only one place (app code)
  owns focus, eliminating the registration-order-vs-schema-order mismatch
  between the toast message and the focused field.

## Prevention

- Never trust a synchronous `formState.errors` read after an `await trigger()`
  — always consume errors via the `onInvalid` handler.
- If you need custom focus behavior, disable `shouldFocusError` first; don't
  let RHF's default focus race your own.
