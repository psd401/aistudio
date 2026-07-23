---
title: Validate server-controlled strings with Zod before rendering in toast descriptions
category: security
tags:
  - zod
  - toast
  - xss
  - input-validation
  - server-controlled
severity: high
date: 2026-05-28
source: auto — lfg-issue-993
applicable_to: project
---

## What Happened

PR #1005 found a server-controlled string being passed directly from an API response into a `toast()` `description` field without validation. Although the current toast library renders descriptions as text (not HTML), the pattern is fragile: a future library upgrade or renderer change could allow XSS, and there is no contract enforcing that the server only returns safe strings.

## Root Cause

When a string from a server response is passed to a UI element without shape validation, the component implicitly trusts the server. In a compromised or misconfigured backend, the string could contain markup, script tags, or excessively long content intended to abuse the UI layer.

## Solution

Parse the server response through a Zod schema before accessing any string that will be rendered:

```typescript
import { z } from "zod";

const ErrorResponseSchema = z.object({
  message: z.string().max(500),   // enforce reasonable length
});

// In the customFetch / response handler:
const body = await response.json();
const parsed = ErrorResponseSchema.safeParse(body);
const description = parsed.success
  ? parsed.data.message
  : "An unexpected error occurred.";

toast.error("Request failed", { description });
```

## Prevention

- Any string from a server response (API, Lambda, third-party) that is rendered in the UI must pass through a Zod schema first.
- Apply `.max()` to string fields that feed UI labels, toasts, or headings — unbounded strings can cause layout abuse.
- Use a safe fallback message when `safeParse` fails so the UI never goes silent on errors.
- This pattern also applies to error messages returned from server actions before they're surfaced in form errors or alert components.
