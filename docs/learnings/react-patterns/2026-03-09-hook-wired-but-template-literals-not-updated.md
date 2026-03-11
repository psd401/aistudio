---
title: Hook import and call added without updating template literals in same component
category: react-patterns
tags:
  - branding
  - context
  - hardcoded-strings
  - migration
  - tutorials
severity: low
date: 2026-03-09
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #828 migrated branding to dynamic settings. In `tutorials/page.tsx`, the `useBranding()` hook was imported and called (likely in a prior commit), but the heading and description text still contained hardcoded `'AI Studio'` string literals. The hook result (`appName`) was never substituted into the template literals.

## Root Cause

Multi-commit migrations can split the hook wiring step from the consumption step. When a reviewer or author verifies that a hook is "already imported and called", they may not re-audit every JSX text node and template literal in the same file for remaining hardcoded values.

## Solution

After confirming the hook is imported and the variable is bound, grep the same file for every hardcoded brand name occurrence and replace with the variable. In this case: replace `'AI Studio'` string literals with `${appName}` or `{appName}`.

## Prevention

After any branding migration commit, run a targeted grep for the literal brand name inside each modified file — not just across the repo. A file can import and call the hook and still have unresolved literals lower in the JSX tree.
