---
title: Gates reading a synthetic command string must use the same dual extraction as execution, or a resolver move silently bypasses the gate
category: security
tags:
  - workspace-broker
  - command-gate
  - placeholder-substitution
  - params-file
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1801 / PR #1822: adding `--params-file` broke the `--params` gate. The resolver inlines the payload-file content as minified JSON, unquoted, directly into the synthetic command string, and `splitCommand` mangles that inline JSON when tokenizing it. A gate that read only the tokenized argv (like the new `--params` gate initially did) missed the value entirely and refused a legitimate `--params-file` move. The existing `--json` gate already handled this by reading the value two ways: tokenized argv first, then a brace-balanced raw-string scan over the synthetic command as fallback.

## Root Cause

Gate code and execution code both consume the same synthetic command string but via different paths (tokenized argv vs. raw string), and only the execution path's transport (payload-file → inlined JSON) was updated. The gate wasn't updated to match, so gate and execution diverged on what the "same" value meant.

## Solution

Gave the `--params` gate the same dual extraction already used by `--json`: try the argv token first, fall back to a brace-balanced scan of the raw synthetic command string.

## Prevention

- Any gate/check that reads a value from a synthetic/reconstructed command string must extract it the same way the executor does — check the existing extraction pattern (e.g. the `--json` gate) before adding a new flag with a different transport.
- When adding a new payload-file-style flag, verify the gate for its plain-value counterpart still fires correctly once the resolver inlines the file content.
