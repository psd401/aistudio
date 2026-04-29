---
title: Pass branding to Lambda via CDK context env vars, not DB access
category: infrastructure
tags:
  - cdk
  - lambda
  - branding
  - env-vars
severity: medium
date: 2026-03-09
source: auto — /work
applicable_to: project
---

## What Happened

Hardcoded PSD branding strings existed across 4 infra files. Replacing them required a pattern for Lambda functions that need branding values but have no database access.

## Root Cause

Lambda functions (e.g., email notification handlers) are deployed independently from the app and cannot call the settings database. Attempting to add DB access purely for branding would be over-engineered.

## Solution

Pass branding as environment variables injected from CDK context at deploy time:

```typescript
// In CDK stack
environment: {
  BRANDING_ORG_NAME: this.node.tryGetContext("brandingOrgName") ?? "AI Studio",
  BRANDING_EMAIL_FROM: this.node.tryGetContext("brandingEmailFrom") ?? "noreply@example.com",
}
```

Lambda reads `process.env.BRANDING_ORG_NAME` with a sensible fallback default. CDK context values are set per-environment in `cdk.json` or passed via `--context` flags.

## Prevention

When a Lambda needs a settings-type value: prefer CDK context env vars over adding DB connectivity. Reserve DB access for Lambda functions that already need it for business logic.
