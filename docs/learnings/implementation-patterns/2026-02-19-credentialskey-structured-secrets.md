---
title: Use credentialsKey to store structured OAuth credentials in Secrets Manager
category: implementation-patterns
tags:
  - mcp
  - oauth
  - secrets-manager
  - schema-design
  - code-review
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

MCP connector service (#778) initial implementation used TODO comments for missing OAuth token refresh logic (client credentials, configurable token endpoint). Code review rejected this approach ("I don't like todo comments. If you think we need to do this, we need to get it done.").

## Root Cause

Schema already had a `credentialsKey` column (AWS Secrets Manager key name) but was underutilized. Implementation attempted to add DB columns for each credential type, creating schema bloat and TODO markers.

## Solution

Store structured JSON in Secrets Manager using the existing `credentialsKey`:
- `credentialsKey` = name of the secret in AWS Secrets Manager (e.g., `mcp-connector-oauth-123`)
- Secret value = JSON object: `{ clientId: string, clientSecret: string, tokenEndpointUrl: string }`
- Retrieve with `SecretsManagerClient.getSecretValue({ SecretId: credentialsKey })`
- Parse JSON and pass to `buildAuthHeaders()` for Bearer token generation

**Also fixed in same PR**:
- `or(condition, undefined)` fragility in Drizzle ORM — wrap undefined checks explicitly
- SSRF blocklist gaps in token endpoint validation
- N+1 query with unnecessary JOIN — use filtered query instead
- Missing `await` on async `buildAuthHeaders()` function

## Prevention

1. When schema has `credentialsKey`/`secretsKey` column, default to storing structured data (JSON) in Secrets Manager rather than expanding schema
2. No TODO comments — either implement the feature or open a follow-up issue with explicit acceptance criteria
3. Always validate async/await pairs in code review (especially in callback chains)
4. Test Drizzle ORM conditions with actual undefined values; avoid `or(x, undefined)` pattern
