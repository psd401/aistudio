---
title: Validate OAuth URLs against SSRF patterns even when sourced from admin-configured secrets
category: security
tags:
  - oauth
  - ssrf
  - secrets-manager
  - mcp-connectors
  - url-validation
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

MCP connector OAuth implementation (#779) read `authorizationEndpointUrl` and `tokenEndpoint` from admin-configured Secrets Manager credentials. Code review flagged that both URLs required SSRF validation before use in redirects and outbound requests.

## Root Cause

URLs from Secrets Manager come from a trusted source (admin-configured credentials), which can create a false sense of security. However, admin configuration can be misconfigured, compromised via credential exposure, or hijacked if the admin account itself is compromised.

## Solution

Always validate both OAuth redirect and token endpoint URLs against SSRF patterns before use:

```typescript
import { isAllowedUrl } from "@/lib/validators";

// After retrieving credentialsKey from Secrets Manager
const credentials = JSON.parse(secretValue);

// Validate both endpoints before use
if (!isAllowedUrl(credentials.authorizationEndpointUrl)) {
  throw new Error("Invalid authorizationEndpointUrl — SSRF pattern detected");
}

if (!isAllowedUrl(credentials.tokenEndpoint)) {
  throw new Error("Invalid tokenEndpoint — SSRF pattern detected");
}

// Safe to redirect or make requests
return redirect(credentials.authorizationEndpointUrl);
```

**Applied to**: `app/api/mcp/oauth/callback` and `lib/mcp/oauth-token-service.ts`

## Prevention

1. **Admin-configured URLs are not automatically safe** — validate even if the source is trusted infrastructure
2. **Validate at boundary entry** — check URLs immediately after retrieval from Secrets Manager
3. **Test malicious URLs** — add unit tests for common SSRF patterns (localhost, 169.254.169.254, internal IP ranges)
4. Reuse existing `isAllowedUrl()` validator rather than custom URL parsing
