---
title: Client-side regex detector for CAST(x AS NUMERIC) needed string-literal blanking, paren-depth matching, and dual entry-point wiring
category: logic
tags:
  - psd-data
  - mcp-skill
  - regex
  - sql
  - false-positive
  - passthrough-bypass
  - infra-agent-image
severity: medium
date: 2026-07-05
source: auto — /lfg (issue #1106, PR #1109)
applicable_to: project
---

## What Happened

Issue #1106 (FS#162394) needed a client-side pre-flight check in the `psd-data`
MCP skill (`infra/agent-image/skills/psd-data/common.js`/`run.js`) that catches
unqualified `CAST(x AS NUMERIC)` / `x::numeric` before sending SQL to the
external `psd-data-mcp` Lambda, which rejects those casts without explicit
precision. The first implementation used a naive `AS <TYPE>\s*\)` boundary
regex to sidestep parsing nested-paren expressions like
`CAST(ROUND(x,2) AS NUMERIC)`.

## Root Cause

Two separate gaps, both found only in review (not in the initial implementation):

1. **Regex false positives**: matching on the `AS <TYPE>\)` boundary alone
   also matched a bare column alias with no CAST at all
   (`(SELECT id, score AS numeric) sub`) and cast-like text sitting inside a
   SQL string literal (`WHERE note LIKE '%CAST(x AS NUMERIC)%'`).
2. **Passthrough bypass**: the check was wired only into the typed `query`
   subcommand. The skill's `call --tool query_data --args <json>` generic
   passthrough — documented in SKILL.md as "a convenience, not a fence,
   always available even for tools with a typed subcommand" — reached the
   same underlying tool without going through the new check at all.

## Solution

- Detect actual `CAST(` tokens, then find the matching closing paren via
  paren-depth tracking (not a boundary regex) so nested expressions resolve
  correctly.
- Blank out string-literal contents (handling `''`-escaped quotes) in a
  pre-pass before scanning, so cast-like text inside literals is never
  matched.
- Wire `findUnqualifiedNumericCasts` into both the `query` subcommand AND the
  `call --tool query_data` passthrough — the same validation must run at
  every entry point that can reach the underlying tool, not just the "main"
  one.

## Prevention

- When writing a regex-based detector for a code/SQL construct, don't stop at
  a boundary-token match — check what else in valid input could produce that
  same boundary text (bare aliases, comments, string literals). Blank
  string/comment regions before scanning for keywords.
- For nested/recursive constructs (CAST inside CAST, parens inside parens),
  track paren depth to find the true closing boundary instead of a lazy
  regex match on the first `)`.
- When a CLI/skill exposes both a typed subcommand and a generic passthrough
  for the same underlying tool (a common pattern — see also
  `docs/learnings/security/2026-06-17-multi-surface-authorization-bypass.md`
  for the same principle in an authz context), any client-side validation
  added to the typed path must also be applied at the passthrough call site,
  or it is trivially bypassable.
