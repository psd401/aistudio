---
title: CloudWatch Insights OR filters mixing log entry types produce empty-column noise; scope generic predicates with co-type guards
category: monitoring
tags:
  - cloudwatch
  - insights-queries
  - log-filtering
  - timer-logs
severity: medium
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #853 added CloudWatch Insights widgets. Two queries had filter defects caught in review:
1. A pie chart used `ispresent(status)` to isolate timer/performance logs, but `status` appears on job logs and HTTP response logs too — the pie chart silently aggregated unrelated entry types.
2. A Content Safety Blocks table ORed `status="blocked"` (timer log) with `error.name="ContentSafetyBlockedError"` (warn log). Because these are structurally different log shapes, matched rows from each branch had empty columns for fields only the other type carries.

## Root Cause

`ispresent(field)` matches any log that carries the named field, regardless of log entry type. When multiple log entry types share a field name (e.g., `status`), the predicate is insufficiently scoped. Similarly, OR-combining structurally different log entry types into one `stats` or `display` query produces rows where columns from one branch are empty for rows matched by the other.

## Solution

- Add a co-predicate that is unique to the target entry type. For timer logs: `ispresent(status) and ispresent(duration)`. `duration` only appears on timer entries.
- Split structurally different log entry types into separate Insights queries rather than ORing them in one filter. Each widget should cover exactly one log shape.

## Prevention

Before publishing any Insights query:
1. Identify every log entry type that could satisfy the `filter` clause.
2. If more than one type matches, add a co-predicate on a field unique to the intended type.
3. Never OR two log entry types that have different field schemas into a single `stats`/`display` query — use separate queries or separate widgets.
