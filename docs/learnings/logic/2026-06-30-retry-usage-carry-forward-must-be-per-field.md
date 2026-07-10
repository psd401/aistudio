---
title: Retry response usage must be adopted per-field, not wholesale, to avoid undercounting
category: logic
tags: [retry, telemetry, agent-platform, token-usage]
severity: medium
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083's Mantle proxy usage tracking handles retried upstream calls. A
retry response can have a differently-shaped usage payload than the original
attempt (e.g. missing a field the first attempt reported).

## Root Cause

If retry usage is adopted wholesale (overwriting the prior attempt's usage
object), a retry response missing a field discards a real token count the
earlier attempt had already captured — silently undercounting total usage.

## Solution

Adopt a retry's usage only when the corresponding field is non-`None`; keep
the earlier attempt's value for any field the retry didn't report. This is a
per-field merge, not a per-response overwrite.

## Prevention

When merging usage/telemetry data across retries of the same logical
operation, merge at the field level and only overwrite with non-null values.
Never let a shorter/partial retry response blank out fields a prior attempt
already populated.
