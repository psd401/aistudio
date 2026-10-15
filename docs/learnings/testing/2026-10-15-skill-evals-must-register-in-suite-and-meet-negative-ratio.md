---
title: New skill eval YAMLs must be registered in a suite, and keep the 25% negative-task ratio
category: testing
tags: [evals, agent-image, ci, skills]
severity: medium
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Added `repositories_create` / `repositories_add_item` MCP tools and two positive eval
YAMLs under `skills/psd-aistudio/evals/`. CI's
`test_committed_skill_suites_meet_issue_1426_contract` in
`infra/agent-image/test_eval_runner.py` failed until fixed in commit `18609d8f5`.

## Root Cause

Two invariants: (1) every committed skill eval YAML must be listed by exactly one suite
in `infra/agent-image/eval/suites/*.yaml` — unregistered files fail a set-comparison
assertion; (2) at least 25% of regression tasks must be negative (asserted via
`len(negative_task_ids) * 4 >= len(tasks)`, cross-multiplied to avoid float math). Two
purely positive additions skewed the ratio (70 tasks vs 17 negatives; 17*4=68 < 70).

## Solution

Register new evals in `eval/suites/regression.yaml`. To satisfy the ratio without
gaming it, add a genuinely useful negative task: `repository-add-item-existing` asserts
the agent files content into an EXISTING named repository rather than calling
`repositories_create` (destructive, private-by-default) and spawning a duplicate. Its id
is added to `negative_task_ids` in `test_eval_runner.py`.

## Prevention

When adding skill evals: (1) list each new YAML in a suite immediately, don't defer it;
(2) if the addition is positive-only, pair it with a real negative case (a plausible
wrong tool-call the agent should avoid) rather than padding the ratio artificially.
