---
title: AI SDK exposes token counts not dollar costs — a stored cost cap is dead code without a custom stopWhen predicate
category: integration
tags:
  - ai-sdk
  - cost-enforcement
  - agentic
  - streaming
  - stopWhen
  - dead-code
  - 926
severity: critical
date: 2026-06-17
source: auto — /lfg
applicable_to: project
---

## What Happened

Issue #926 stored a per-session cost cap in the database and surfaced it in the UI. The enforcement code (`isCostCapExceeded`) existed but was never called — no path connected it to the streaming loop. Agents ran without any cost ceiling.

## Root Cause

The AI SDK (`streamText` / `generateText`) reports only token counts (`usage.promptTokens`, `usage.completionTokens`) per step — there is no built-in dollar cost field. Without converting tokens to dollars using the per-model rate, there is nothing to compare against the stored cap. The enforcement function existed but assumed it would be called somewhere it never was.

## Solution

Wired a `stopWhen` predicate into the streaming base adapter that:
1. Reads the per-token rates from the model row (stored in the DB alongside the model definition).
2. Accumulates `(promptTokens * inputRate) + (completionTokens * outputRate)` across steps.
3. Returns `true` (stop) when the running total exceeds the cap, which causes `streamText` to halt before the next step.

## Prevention

- A cost cap stored in the DB but not wired to a `stopWhen` or abort signal is dead code — treat it as a P1 on discovery.
- The AI SDK never surfaces dollar cost; always thread per-token rates from the model row into any cost-enforcement predicate. Do not assume the SDK will provide this.
- When adding any agentic feature with a resource limit (cost, steps, tokens), write a test that verifies the limit actually stops execution — not just that the stored value is set correctly.
