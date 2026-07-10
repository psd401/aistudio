---
title: Gating an unrelated feature behind an existing guard silently couples two concerns
category: logic
tags: [code-review, coupling, agent-platform, maintainability]
severity: medium
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083 found that `stream_options.include_usage` injection (needed for
GLM-5 token telemetry) was gated behind the pre-existing `if messages:` guard
that was actually there for tool-call-id repair logic in the Mantle proxy.

## Root Cause

Reusing an existing conditional for a new, unrelated concern creates a
hidden coupling. A future change to the tool-call-id-repair guard (e.g.
narrowing its condition, or removing it once repair is no longer needed)
would silently disable token usage tracking with no visible connection
between the two features.

## Solution

Give `include_usage` injection its own independent guard/condition, separate
from the tool-call-id-repair logic, even though both currently happen to be
true under the same `if messages:` check.

## Prevention

When adding new behavior near existing conditional logic, ask whether the
condition is actually shared business logic or just an accidental overlap.
Independent concerns should have independent guards, even at the cost of a
seemingly redundant `if`.
