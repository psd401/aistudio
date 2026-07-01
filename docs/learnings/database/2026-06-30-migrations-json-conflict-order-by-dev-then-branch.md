---
title: Resolving migrations.json conflicts — append dev's entry before the branch's own
category: database
tags:
  - migration
  - merge-conflict
  - migrations-json
  - git
  - atrium
severity: medium
date: 2026-06-30
source: auto — /lfg
applicable_to: project
---

## What Happened

PR #1088 (Atrium Phase 5, issue #1055) conflicted with `dev` on `infra/database/migrations.json`. `dev` had added `088-glm5-agent-pricing.sql` while the branch added `090` and `091`. Migration SQL files themselves live in `infra/database/schema/`, not `infra/database/migrations/` — only the manifest (`migrations.json`) needed a merge.

## Root Cause

Both branches appended new migration entries to the same manifest array/tail; a normal git merge can't infer relative ordering between two divergent additions.

## Solution

Resolved by including all three entries in ascending numeric order: `088` (from `dev`) first, then `090` and `091` (from the branch) — matching the numeric IDs already baked into the filenames, not the order either branch happened to list them in the conflicted diff.

## Prevention

- When `migrations.json` conflicts, resolve by sorting entries by migration number, not by "ours"/"theirs" — always keep `dev`'s newly-landed entries and append the branch's own after them.
- Remember the manifest (`migrations.json`) and the actual SQL (`infra/database/schema/*.sql`) are separate files — a conflict in one doesn't imply a conflict in the other.
- See [[migration-id-sequence-divergence]] for a related but distinct migration pitfall (ID reuse across backfilled tables, not manifest merge order).
