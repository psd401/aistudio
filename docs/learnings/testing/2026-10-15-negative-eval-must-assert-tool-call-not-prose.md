---
title: A negative eval must assert on the tool call, not the model's prose
category: testing
tags: [evals, agent-image, grading]
severity: medium
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Added `aistudio-repository-add-item-existing` eval
(`infra/agent-image/skills/psd-aistudio/evals/repository-add-item-existing.yaml`) to
assert the agent never calls `repositories_create` when asked to file content into an
already-named existing repository.

## Root Cause

An `output_match` grader checking for the ABSENCE of a phrase in the final answer
passes whenever the model phrases its reply differently — a stray `repositories_create`
call followed by a tactfully-worded closing sentence would slip past a text match even
though the wrong tool fired.

## Solution

Assert at the tool-call level instead: `no_route_called` with a `body` matcher
(`{"type":"no_route_called","route":"/api/agent/aistudio","method":"POST","body":{"params.name":{"exact":"repositories_create"}}}`).
The grader schema accepts `route`, `method`, and `body` so the check targets the actual
MCP call, not the surrounding narration.

## Prevention

For any negative eval whose failure mode is "the agent called the wrong tool," grade
the broker request body (`no_route_called` / `broker_request` with `params.name`), not
`output_match` against the final text — text-level negative assertions only catch
wording, not behavior.
