---
title: Combined COALESCE across input/output SUMs collapses cost to $0 on partial pricing
category: database
tags: [sql, coalesce, postgres, cost-calculation, null-handling]
severity: high
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083 added cost calculation for GLM-5 agent usage: token volume ×
`ai_models` pricing (per-1k-token USD, migration 029 convention). A model
priced on only one direction (e.g. input price set, output price `NULL`)
caused the computed cost to silently read $0 for all rows, not just the
missing direction.

## Root Cause

The original SQL wrapped the whole cost expression in one outer `COALESCE`
around `SUM(input_tokens * input_price) + SUM(output_tokens * output_price)`.
In SQL, `X + NULL = NULL`, so if either side's price is `NULL` the entire sum
becomes `NULL` before the outer `COALESCE` can apply — collapsing a partially
priced model's real cost to zero instead of just zeroing the missing side.

## Solution

`COALESCE` each direction's `SUM(...)` separately, then add:
```sql
COALESCE(SUM(input_tokens * input_price), 0) + COALESCE(SUM(output_tokens * output_price), 0)
```
Verified against local DB with a model that has only one price direction set.

## Prevention

Any SQL that sums multiple nullable-priced components must `COALESCE` each
component individually before combining with `+`. Never rely on one outer
`COALESCE` to cover an expression tree with multiple independently-nullable
terms.
