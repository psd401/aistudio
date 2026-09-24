---
title: Placeholder substitution must be scoped to the flag position the resolver emitted it in
category: security
tags:
  - workspace-broker
  - placeholder-substitution
  - params-file
  - flag-aliasing
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1801 / PR #1822: when the resolver replaces a `--params-file` reference with an inlined payload placeholder, the substitution was not restricted to the value position of `--params-file` specifically. A caller could alias the same placeholder into a different flag (e.g. `--json`), making the gate's view of the command diverge from what actually got executed — the gate would evaluate one flag's value while the executed argv used it as another flag's value.

## Root Cause

Placeholder substitution logic matched the placeholder token wherever it appeared in the command string rather than restricting the replacement to the specific `--<flag>` position the resolver originally put it in.

## Solution

Restored the payload placeholder substitution so it only fires in the value position of the flag the resolver emitted it for (`--params-file`), not anywhere the token happens to appear.

## Prevention

- When a resolver inlines a payload behind a placeholder token, the substitution step must scope the match to the exact flag position it was generated for — never a bare string replace across the whole command. Otherwise a caller can alias the payload into a different flag and make the security gate's view of the command diverge from the executed argv.
