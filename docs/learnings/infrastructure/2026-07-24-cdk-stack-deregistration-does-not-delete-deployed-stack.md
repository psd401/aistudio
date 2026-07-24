---
title: Removing a stack from the CDK app doesn't delete it — cdk destroy silently no-ops
category: infrastructure
tags:
  - cdk
  - cloudformation
  - decommission
  - teardown
  - stack-removal
severity: high
date: 2026-07-24
source: auto — /work
applicable_to: project
---

## What Happened

Decommissioning the legacy scheduling feature (#1322/PR #1323) required retiring
`AIStudio-SchedulerStack-{Env}` and `AIStudio-EmailNotificationStack-{Env}`. Removing
their registrations from `infra/bin/infra.ts` only stops *future* synthesis from
including them — the already-deployed CloudFormation stacks (Lambdas, EventBridge
schedules, SQS queue, ongoing cost) are untouched by `cdk deploy --all`.

## Root Cause

`cdk destroy <StackName>` resolves the stack against the *currently synthesized* CDK
app, not against what's actually deployed in AWS. Once a stack's registration is
removed from `bin/infra.ts`, `cdk destroy AIStudio-SchedulerStack-Dev` matches nothing
in the synthesized assembly and exits silently without error — an operator can
reasonably believe teardown happened while the resources and cost remain live.
Separately, the `FrontendStack-ECS` imports the `{env}-NotificationQueueUrl`
CloudFormation export from the queue-owning stack; CloudFormation blocks deleting a
stack whose export is still imported elsewhere.

## Solution

- Delete the retired stack by name via the CloudFormation API instead of `cdk destroy`:
  `aws cloudformation delete-stack --stack-name <name>` followed by
  `aws cloudformation wait stack-delete-complete --stack-name <name>` (surfaces
  `DELETE_FAILED` if an export dependency wasn't cleared first).
  (`cdk destroy` from a checkout of the pre-removal commit also works, but the CLI path
  has no dependency on CDK app state.)
- Deploy the stack that *imports* another stack's CFN export (e.g. `FrontendStack-ECS`
  importing `{env}-NotificationQueueUrl`) BEFORE deleting the exporting stack.
- Persisted as an in-repo runbook: `docs/operations/decommission-scheduled-executions.md`.

## Prevention

Never treat "removed from `bin/infra.ts`" as equivalent to "torn down." Any stack
decommission needs an explicit, ordered runbook: (1) deploy dependents that import the
target stack's exports first, (2) `aws cloudformation delete-stack` + `wait` by name,
(3) sweep resources with `RemovalPolicy.RETAIN` or created at runtime outside
CloudFormation (e.g. EventBridge Scheduler entries a Lambda created dynamically) —
these survive stack deletion and need manual cleanup.
