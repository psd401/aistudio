---
title: Grant cross-stack lambda:InvokeFunction on a constructed ARN, not a cross-stack object import
category: infrastructure
tags: [cdk, iam, lambda, cross-stack, circular-dependency, ServiceRoleFactory, agent-workspace]
severity: medium
date: 2026-07-15
source: auto — /work
applicable_to: project
---

## What Happened

PR #1236 (#1232) needed the frontend ECS task role (`FrontendStack`) to invoke a new Lambda defined in `AgentPlatformStack`, without creating a new cross-stack coupling in the wrong direction.

## Root Cause

Granting `lambda:InvokeFunction` the "normal" way (`mintLambda.grantInvoke(taskRole)`) requires importing the `lambda.Function` object across stacks, which creates a stack dependency. `FrontendStack` already depends on `AgentPlatformStack`, so this particular direction wouldn't have been circular here, but the pattern is fragile in general and unnecessary when the target name is known ahead of time.

## Solution

- In `infra/lib/constructs/ecs-service.ts`, grant `lambda:InvokeFunction` on a manually **constructed ARN string** built from the deterministic function name (`psd-agent-mint-{environment}`), instead of importing the `lambda.Function` object from `AgentPlatformStack`.
- This works because `ServiceRoleFactory`-created roles/functions use stable, predictable names (`<functionName>-execution-role-<env>` for the role; `<functionName>-<env>` for the Lambda) — the same determinism that lets IT (Google WIF admin) pre-configure trust before deploy (see the confused-deputy isolation learning) also lets a sibling stack construct the ARN without an object reference.

## Prevention

- When a cross-stack IAM grant only needs a resource ARN (not the construct's other properties), prefer building the ARN from a deterministic resource name over importing the construct — avoids adding a new stack dependency edge, especially useful when the dependency direction is uncertain or could become circular later.
- Confirm the target resource's naming really is deterministic (fixed `functionName`, not CDK auto-generated) before relying on this pattern.
