---
title: TypeScript does not narrow union types through throw guards before async return sites
category: logic
tags:
  - TypeScript
  - type-narrowing
  - union-types
  - throw
  - async
  - server-actions
severity: low
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

An Atrium server action guarded `if (version.bodyFormat === "markdown") { throw ... }` before calling `createSuccess({ bodyFormat: version.bodyFormat })`. The intent was that TypeScript would narrow `bodyFormat` to `"html" | "jsx"` at the return site. It did not — the return type remained the full `BodyFormat` union, requiring a cast.

## Root Cause

TypeScript's control-flow narrowing works within a single synchronous scope and does not carry forward through the type signature of an action's return type. The function's declared return type (`ActionState<{ bodyFormat: BodyFormat }>`) is what callers see — the throw guard inside the body does not retroactively narrow the interface seen at the call site.

## Solution

Widen the return type interface to accept the full union (`BodyFormat`), and let callers handle the full range of values (which they already accept, since they receive `ActionState<T>`). This avoids casting and is accurate — the action can return any `BodyFormat` value that wasn't thrown:

```typescript
// Return type: ActionState<{ bodyFormat: BodyFormat }>
// Caller already handles all variants — no cast needed
```

If the narrowed type is genuinely required at the call site, use a discriminated union return value instead of relying on throw-based narrowing.

## Prevention

Do not rely on `throw` guards inside a function body to narrow the function's return type as seen by external callers. TypeScript does not propagate intra-body narrowing into exported return type signatures.
