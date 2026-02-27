---
title: Tool execute() sanitization is dead code when return value is {id,success}; use Object.create(null) for model-controlled key accumulators
category: security
tags:
  - prototype-pollution
  - tool-execute
  - sanitization
  - ai-sdk
  - dead-code
  - xss
severity: high
date: 2026-02-23
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #810 review found two security issues in a chart tool:

1. `sanitizeChartArgs()` inside `execute()` built and returned a sanitized copy of args, but `execute()` itself only returns `{ id, success }`. The sanitized object was never used — the frontend reads args directly from the AI SDK tool invocation stream, bypassing `execute()` output entirely.

2. A data-reduction loop used a plain object (`{}`) as an accumulator while iterating model-controlled keys. Keys like `__proto__` or `constructor` could pollute the object prototype chain.

## Root Cause

1. Misunderstanding of AI SDK data flow: `execute()` is for side effects and returning a result to the model. The frontend UI reads args from the streaming tool invocation object, not from the `execute()` return value. Sanitizing args inside `execute()` has no effect on what the render layer sees.

2. Using `{}` as an accumulator when keys originate from model output. Plain object literals inherit from `Object.prototype`, so a key of `__proto__` becomes a prototype mutation rather than an own property.

## Solution

1. Moved XSS sanitization to the render component (the only place that actually uses args for HTML output).

2. Changed accumulator initialization from `{}` to `Object.create(null)` to produce a prototype-free object immune to `__proto__` pollution.

```typescript
// Before — prototype pollution risk
const result = data.reduce((acc, item) => {
  acc[item.modelKey] = item.value;  // __proto__ pollutes here
  return acc;
}, {});

// After — safe accumulator
const result = data.reduce((acc, item) => {
  acc[item.modelKey] = item.value;
  return acc;
}, Object.create(null));
```

## Prevention

- If `execute()` returns only an ID or status, any arg sanitization inside it is dead code. Sanitize at the render layer instead.
- Always use `Object.create(null)` (not `{}`) as an accumulator when iterating keys that originate from model/user-controlled data.
- Audit tool `execute()` return types: if the return shape doesn't include sanitized args, in-execute sanitization achieves nothing for XSS defense.
