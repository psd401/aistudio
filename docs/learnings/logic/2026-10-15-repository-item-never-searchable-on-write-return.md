---
title: A repository item is never searchable the moment the write call returns
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

Neither write path makes an item searchable synchronously:
- Canonical path (`lib/repositories/repository-write-service.ts`): status is set to
  `pending`, with no generation/embedding yet.
- Legacy (pre-cutover) path: status is set to `completed` immediately, but the chunk is
  inserted with a NULL `embedding` and no `index_generation_id`.

Every retrieval query filters on `chunk.embedding IS NOT NULL`
(`lib/repositories/search-service.ts`), and retrieval v2 additionally requires
`chunk.index_generation_id = snapshot.generationId`
(`lib/repositories/retrieval-v2/service.ts`). So `processingStatus === "completed"` is
NOT a searchability signal on either path — it only means the legacy row and canonical
shadow-write attempt finished, not that embeddings exist.

## Solution

Do not surface "searchable now" to the caller based on write-call completion.
Distinguish "written" from "indexed" explicitly, and treat embedding generation as
async on both the canonical and legacy paths.

## Prevention

When adding any tool/action that reports repository item state after a write, check the
retrieval query's actual WHERE clause (embedding + generation_id), not the item's
`processingStatus` column, before claiming the item is searchable.
