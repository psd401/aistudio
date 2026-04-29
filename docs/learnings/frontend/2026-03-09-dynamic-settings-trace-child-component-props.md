---
title: Dynamic settings migration must trace ALL usage sites including child component props
category: frontend
tags:
  - branding
  - react-context
  - review-patterns
  - testing
severity: medium
date: 2026-03-09
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #828 replaced hardcoded branding values with dynamic settings. A reviewer caught that the featured card image was updated from `/psd-ai-logo.png` to `/logo.png` but was not wired to the dynamic `logoSrc` from the branding context. The parent component (`ToolCardsGrid`) called `useBranding()` but never passed the value down as a prop, so the child component kept a static path.

## Root Cause

The audit checked which components called the hook, not which components consumed branding values via props. A child component can use a hardcoded value even when its parent correctly calls `useBranding()` — the value simply never gets passed down.

## Solution

When replacing hardcoded branding values:
1. Grep for the old literal strings (e.g., `/psd-ai-logo.png`, `sky-600`) across the full component tree, not just files that call the hook
2. For each hit, check whether the parent component supplies that value dynamically or still passes a static string
3. Confirm the dynamic value flows all the way from the hook call to the rendered attribute

## Prevention

- After any settings-driven replacement, run: `grep -rn "psd-ai-logo\|sky-600\|old-brand-token" app/ components/` to catch survivors
- Review PR diffs for child components that receive image/color props — verify prop is dynamic, not a newly-renamed static string
- Add E2E tests that assert the rendered value changes when the setting changes (not just that the UI renders)
