---
title: Bedrock Guardrails accepts asymmetric inputStrength/outputStrength per filter
category: infrastructure
tags:
  - bedrock
  - guardrails
  - content-safety
  - asymmetric-filtering
severity: high
date: 2026-03-12
source: auto — /work
applicable_to: project
---

## What Happened

Educational content was triggering 100% false positive rate on HATE output filtering. Setting outputStrength to NONE while keeping inputStrength at LOW resolved all false positives and still satisfies Bedrock's minimum non-NONE filter requirement.

## Root Cause

Bedrock Guardrails content filter configuration supports per-direction strength settings (`inputStrength`/`outputStrength`) independently, but this is underdocumented. The assumption was that input and output strengths must match or that NONE on output would be rejected.

## Solution

Configure the HATE filter asymmetrically in the CDK guardrails stack (`infra/lib/guardrails-stack.ts`):
- `inputStrength: LOW` — catches genuinely hateful user prompts
- `outputStrength: NONE` — eliminates false positives on educational AI output

Validated via `bunx cdk synth` before deploying. Bedrock accepts this configuration.

## Prevention

When a content filter causes false positives only in one direction (input vs. output), try asymmetric strength before disabling the filter entirely. This preserves the minimum non-NONE requirement (at least one filter must be non-NONE) while eliminating noise on the unaffected direction.
