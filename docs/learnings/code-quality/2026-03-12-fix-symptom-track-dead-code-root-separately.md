---
title: Fix dangerous symptom first, track dead-code root as separate concern
category: code-quality
tags:
  - dead-code
  - openai
  - provider-adapter
  - response-format
  - security-audit
severity: medium
date: 2026-03-12
source: auto — /review-pr
applicable_to: project
---

## What Happened

A security audit found a `response_format: json_object` block inside the OpenAI adapter's `isResponsesAPI` branch. If that branch were ever reachable, it would force all Responses API streaming through JSON object mode, mangling prose responses. The flag was never set anywhere in the codebase — making the entire ~127-line branch dead code.

## Root Cause

The immediate risk (the dangerous config block) was removed as a 10-line deletion with zero behavioral change. The broader root cause — the unreachable branch itself — still exists as acknowledged dead code.

## Solution

Two-step approach:
1. Remove the dangerous symptom (the `response_format` block) immediately — zero behavioral risk, clear security improvement.
2. Track removal of the entire dead branch as a separate follow-up concern, not in the same PR.

## Prevention

When a security audit surfaces a dangerous config inside a dead code path:
- Do not defer the symptom fix because the root is larger — remove it immediately.
- Do not bundle dead-code cleanup into the same security fix PR — keeps diffs minimal and reviewable.
- Leave a `// TODO: remove entire isResponsesAPI branch — never activated` comment at the branch entry point so the follow-up is discoverable.
