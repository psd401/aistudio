---
title: Bedrock guardrail assessment — check ALL sub-properties of SDK objects
category: monitoring
tags:
  - aws
  - bedrock
  - guardrails
  - assessment
  - sdk-types
  - logging
severity: high
date: 2026-03-12
source: auto — /work
applicable_to: project
---

## What Happened

During guardrail tuning analysis for Issue #763, `extractBlockedCategories()` was only checking `wordPolicy.customWords` and ignoring `wordPolicy.managedWordLists`. PROFANITY is enforced via a managed word list — one of only 2 active blocking policies — so every PROFANITY block was invisible in logs and SNS notifications.

## Root Cause

The AWS SDK `WordPolicyAssessment` type has two distinct sub-properties: `customWords` and `managedWordLists`. The extraction function was written assuming `wordPolicy` was a flat object, missing the second sub-property entirely.

## Solution

When iterating an AWS SDK assessment object, inspect the full TypeScript type definition (or SDK docs) for every sub-property. For `wordPolicy`:

```typescript
// Wrong — misses managed word list blocks
wordPolicy?.customWords?.forEach(...)

// Correct — covers both paths
wordPolicy?.customWords?.forEach(...)
wordPolicy?.managedWordLists?.forEach(...)
```

## Prevention

- Before shipping any monitoring/extraction function that reads AWS SDK assessment objects, enumerate all properties of the relevant type (e.g., `aws-sdk-v3` TypeDoc or `@aws-sdk/client-bedrock-runtime` source).
- Treat assessment object coverage as a correctness invariant, not best-effort: a missing sub-property silently drops an entire blocking category from observability.
- When adding or changing active guardrail policies, grep `extractBlockedCategories` (or equivalent) to confirm the new policy type is handled.
