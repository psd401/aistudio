---
title: Evolve tasks on documentation-only PRs follow a distinct three-step pattern
category: documentation
tags:
  - evolve
  - lfg
  - documentation
  - claude-md
  - security-review
severity: low
date: 2026-05-14
source: auto — /lfg issue-891
applicable_to: project
---

## What Happened

PR #986 (issue #891) was a documentation-only evolve task: add 6 new silent failure
patterns from March–April learnings to `docs/guides/silent-failure-patterns.md` and
mirror compact bullets for each into `CLAUDE.md`'s Silent Failures section.

Three recurring pitfalls were identified during and after the run.

## Root Cause

Documentation evolve tasks differ from code tasks in ways that catch agents off-guard:

1. **Research gap**: Agents that write the guide before reading all referenced learning
   files produce incomplete or mismatched entries.
2. **CLAUDE.md drift**: The Silent Failures section in `CLAUDE.md` is a compact mirror
   of the full guide; new guide entries that are not also added to `CLAUDE.md` break the
   implicit sync contract and reduce the value of both documents.
3. **Wasted security-review time**: Running a full security audit on a pure-documentation
   PR adds unnecessary latency — there is no executable code, so injection, SSRF, and
   secret-leakage vectors do not apply. Wrong code *examples* framed as anti-patterns are
   a skim-reading hazard at most (LOW risk).

## Solution

For documentation-only evolve tasks, follow this order:

1. **Research first** — read every learning file referenced by the issue before writing
   a single line of the guide. Match the existing guide's tone, heading style, and code
   block conventions.
2. **Mirror to CLAUDE.md** — for every new entry added to the guide, add a matching
   compact bullet to the relevant `CLAUDE.md` section immediately (same PR, same commit).
   The two documents must stay in sync.
3. **Lightweight security pass** — for doc-only PRs, security review can be limited to
   confirming no secrets, credentials, or live URLs are embedded. Skip the full SSRF /
   injection / taint analysis — it does not apply.

## Prevention

- Before opening the PR, verify: (a) guide entry count == `CLAUDE.md` bullet count for
  the same section, (b) footer date range on the guide is updated.
- If the issue references specific learning files by path, read them all before writing.
- Tag doc-only PRs clearly so automated security review pipelines can apply the
  appropriate (lighter) rule set.
