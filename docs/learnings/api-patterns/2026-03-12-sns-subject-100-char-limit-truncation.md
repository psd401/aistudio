---
title: SNS Subject 100-char limit causes silent publish failures when joining arrays
category: api-patterns
tags:
  - sns
  - aws
  - notifications
  - guardrails
  - type-safety
severity: high
date: 2026-03-12
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #858 (guardrail tuning + PROFANITY block attribution fix) used `blockedCategories.join(", ")` to construct the SNS Subject line. When multiple categories are blocked simultaneously, the joined string exceeds SNS's 100-character hard limit, causing silent publish failures — the notification is dropped with no error surfaced to the caller.

## Root Cause

SNS `publish()` rejects subjects > 100 characters, but the SDK does not throw a runtime error visible in normal success-path logging. Any array-to-string mapping on the Subject field is therefore a latent silent failure waiting for a multi-category event.

## Solution

Add a truncation guard before publishing:

```typescript
const subject = `Guardrail blocked: ${blockedCategories.join(", ")}`;
const safeSNSSubject = subject.length > 100 ? subject.slice(0, 97) + "..." : subject;
```

Apply the same guard to any other dynamic SNS Subject construction.

## Prevention

- Treat SNS Subject as a 100-char-max field — enforce at the point of construction, never rely on the caller to stay under the limit.
- When the subject is derived from a variable-length array, always add `.slice(0, 97) + "..."` truncation.
- Code-review checklist: flag any `array.join()` or template literal used as SNS Subject without a length guard.
