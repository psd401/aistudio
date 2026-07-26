---
title: Derive an AWS regional endpoint from the OIDC issuer's origin, not a region env var
category: integration
tags:
  - cognito
  - oidc
  - edge-runtime
  - ecs
  - aws-region
  - fetch
severity: medium
date: 2026-07-26
source: auto — /lfg (PR #1350, issue #1297)
applicable_to: project
---

## What Happened

`lib/auth/cognito-refresh.ts` needs to POST `InitiateAuth` to the right regional
Cognito IDP host (`https://cognito-idp.{region}.amazonaws.com/`) from Edge
Runtime, where the AWS SDK's region-resolution chain is unavailable. Rather than
reconstructing the host from a region env var, it parses `AUTH_COGNITO_ISSUER`
(`https://cognito-idp.{region}.amazonaws.com/{userPoolId}`) with `new URL()` and
uses `url.origin` directly.

## Root Cause

`AWS_REGION` is not actually set on ECS Fargate task containers unless the task
definition explicitly sets it — it's a Lambda-runtime convention, not a
universal ECS one. Code that assumed it would be present as a fallback source
of truth for region would silently misresolve the endpoint in production. The
OIDC issuer URL, by contrast, is always configured (auth would not work
otherwise) and its origin already encodes the correct region *and* partition
(gov-cloud, ISO, etc.) for free — no separate partition-detection logic needed.

## Solution

```ts
const url = new URL(issuer)
if (url.protocol === "https:" && COGNITO_IDP_HOST_RE.test(url.hostname)) {
  return `${url.origin}/`
}
// fall back to constructing from envRegion only if issuer is absent/malformed
```

Validate the hostname against an allowlist regex before using it as a fetch
target (readable from an env var an attacker could theoretically influence in
a misconfigured environment) — don't trust `url.origin` blindly.

## Prevention

- When a service needs a regional AWS endpoint and only has `fetch` (Edge
  Runtime, no SDK), prefer deriving it from an already-required issuer/config
  URL's `origin` over reassembling it from a region env var.
- Never assume `AWS_REGION` is set outside Lambda; ECS/Fargate tasks only have
  it if the task definition sets it explicitly.
- Keep a region env var as a secondary fallback, not primary source, and
  validate it with a strict regex before interpolating into a URL.
