---
title: "ECS sets NODE_ENV=production for all environments; use ENVIRONMENT to distinguish dev vs prod"
category: aws
tags:
  - ecs
  - node-env
  - ecs-env-vars
  - secrets-manager
  - environment-config
severity: high
date: 2026-02-18
source: auto — /work
applicable_to: project
---

## What Happened

ECS task definitions in this codebase set `NODE_ENV=production` for all deployment environments, including dev. Code that resolved the Secrets Manager path using `NODE_ENV` pointed to the prod secret path even on dev tasks, causing `AccessDenied` errors for dev task IAM roles.

## Root Cause

`NODE_ENV=production` is a Node.js runtime convention (enables production optimizations), not a deployment environment discriminator. ECS sets it universally. It does not map to dev/staging/prod deployment tiers.

## Solution

Use the `ENVIRONMENT` environment variable (injected from the CDK environment prop, e.g., `dev` | `staging` | `prod`) to distinguish deployment environments in application code:

```typescript
// Wrong
const secretPath = process.env.NODE_ENV === 'production'
  ? '/prod/mcp/dek'
  : '/dev/mcp/dek';

// Correct
const env = process.env.ENVIRONMENT ?? 'dev';
const secretPath = `/${env}/mcp/dek`;
```

## Prevention

- Never use `NODE_ENV` to select AWS resource paths or environment-scoped secrets
- Always use `ENVIRONMENT` (set by CDK via the environment prop) for deployment environment branching
- Add a lint/grep rule or code review checklist item: flag `process.env.NODE_ENV` in infrastructure path resolution
