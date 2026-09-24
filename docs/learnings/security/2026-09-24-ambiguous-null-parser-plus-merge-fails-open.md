---
title: Ambiguous null from a param parser + a defaults-merge-and-writeback turns a refusal into a silent widen
category: security
tags:
  - workspace-broker
  - drive-query
  - fail-open
  - parser-null-ambiguity
  - merge-writeback
severity: critical
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1801 / PR #1822: the Google Workspace agent broker silently dropped Drive `q` filters. `splitCommand` (`infra/agent-image/skills/psd-workspace/common.js`) has no quote-escape syntax, but Drive's query language requires single-quoted string values, so a Drive `q` predicate could never be expressed inline in `--params`. `parseObjectArgument` then returned `null` for it, and `withSharedDriveSupport` (`lib/agent-workspace/command-executor.ts`, added in #1640) fell back to `{}`, merged in `supportsAllDrives`/`includeItemsFromAllDrives`, and wrote that back — so `gws` listed everything the identity could see instead of erroring. At least 8 users hit this 2026-08-19 to 2026-09-01.

## Root Cause

Two compounding issues: (1) `parseObjectArgument` returned `null` for both "argument absent" and "argument present but unparseable" — the caller can't tell those apart, so every downstream gate reading it fails open. (2) `withSharedDriveSupport` treated that ambiguous `null` as "no params" and merged its own defaults into `{}`, then wrote the merged object back over the original unparseable value — converting what should have been a loud parse error into a silently different, broader query.

## Solution

- Made the parser distinguish "absent" from "unparseable" so callers get an explicit refusal instead of a null they must guess about.
- Added a payload-file transport (`--params-file`, alongside existing `--json-file`/`--body-file`/`--text-file`) so Drive `q` values containing single quotes can be carried without going through the escape-less tokenizer at all.
- Stopped the defaults-merge from writing back over a value it could not parse.

## Prevention

- A parser/lookup helper must never collapse "absent" and "unparseable" into the same sentinel (`null`/`undefined`) if any caller uses that sentinel to decide default behavior — refuse loudly at the boundary instead.
- A transform that merges defaults into a caller-supplied value must never write the merged result back over a value it could not itself parse.
- When a tokenizer has no escape syntax, a payload-file transport (content becomes exactly one argv token) is the reliable way to carry values containing quotes — don't try to teach the tokenizer escaping instead.
