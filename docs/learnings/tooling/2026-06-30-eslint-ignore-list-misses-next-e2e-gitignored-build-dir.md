---
title: Local `bun run lint` inflates error count from gitignored .next-e2e build artifacts
category: tooling
tags:
  - eslint
  - lint
  - ci
  - build-artifacts
  - gitignore
severity: low
date: 2026-06-30
source: auto — /lfg
applicable_to: project
---

## What Happened

During PR #1088, `bun run lint` (`eslint .`) reported ~3147 errors locally, but CI passed cleanly on the same branch. Nearly all (~3158) came from the gitignored `.next-e2e/` build-artifact directory — minified bundles triggering `no-undef`/`no-func-assign` — not from tracked source.

## Root Cause

`eslint.config.mjs`'s ignore list covers `.next/**` but not `.next-e2e/**`. A local checkout that has ever run the E2E build accumulates this directory; CI always starts from a fresh checkout and never generates it, so it never sees the noise.

## Solution

Ignored the phantom errors and scoped judgment to tracked, changed files only (`git diff --name-only` intersected with lint output). Confirmed the repo's real lint policy is 0-errors/warnings-tolerated on tracked code, and CI is authoritative for that count.

## Prevention

- Don't trust a raw local `bun run lint` (or `eslint .`) count if `.next-e2e/` exists in the working tree — check `eslint.config.mjs`'s ignore globs first, or scope lint to `git diff` file lists.
- Consider adding `.next-e2e/**` to `eslint.config.mjs`'s ignore list to eliminate this false signal permanently (proposed, not yet implemented as of this PR).
- CI (fresh checkout) is the source of truth for lint pass/fail, not a long-lived local working tree.
