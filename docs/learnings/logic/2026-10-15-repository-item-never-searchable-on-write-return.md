---
title: Item searchability after a write depends on the write path, not processingStatus
category: logic
tags: [repositories, embeddings, retrieval, async]
severity: medium
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Built `repositories_add_item`; initial version reported newly added items as
immediately searchable based on `processingStatus`. Fixed in commit `999595c1a`
("never report a just-added item as searchable, and distinguish failed ingestion").

## Root Cause

The two write paths differ, and `processingStatus` describes neither correctly:
- Canonical path (`lib/repositories/repository-write-service.ts`): status is set to
  `pending`, with no generation/embedding yet — not searchable at all.
- Legacy path (content dual-write off): status is `completed` immediately and the chunk
  is inserted with a NULL `embedding` and no `index_generation_id`. Retrieval v1
  (`lib/repositories/search-service.ts`) filters on `chunk.embedding IS NOT NULL`, so it
  cannot see it. But retrieval v2's `legacyCompatibilityCandidates`
  (`lib/repositories/retrieval-v2/service.ts`) matches legacy chunks on the GENERATED
  `search_vector` column with no embedding requirement, in every mode, and
  `repositories_search` leaves `includeLegacyCompatibility` at its default (on). So the
  item is keyword-searchable at once. It is NOT semantically searchable later either:
  embedding-recovery (`content-platform/embedding-recovery.ts`) only claims chunks of a
  canonical generation and dense retrieval only reads active canonical generations, so
  a legacy chunk stays keyword-only until canonical ingestion. (Codex caught both this
  and the original "never searchable" claim on PR #1931.)

A first fix reported `searchable: false` on both paths; Codex caught the legacy case
(PR #1931). The shipped contract is `searchable: "no" | "keyword"` with
`ingestion: "processing" | "completed" | "failed"`.

## Solution

Report searchability per path and per retrieval mode, from the retrieval queries'
actual predicates. Distinguish "written", "keyword-matchable" and "semantically indexed".

## Prevention

When adding any tool/action that reports repository item state after a write, check the
retrieval queries' actual WHERE clauses (embedding, generation_id, AND any
legacy-compatibility branch that skips them), not the item's
`processingStatus` column, before claiming the item is searchable.
