---
title: Two Lambdas in one CDK stack update in unordered sequence — pin producer-after-consumer with addDependency
category: infrastructure
tags: [cdk, lambda, sqs, deploy-ordering, agent-schedules]
severity: high
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

Issue #1890's cron Lambda queues an SQS envelope that the router Lambda
parses with a strict key allowlist. Both Lambdas live in the same CDK
stack. CloudFormation does not guarantee which of two sibling resources in
a stack updates first on a multi-Lambda deploy.

## Root Cause

In the window where a new cron deploys before the old router does, the
cron starts emitting a new envelope field the still-old router's strict
allowlist doesn't recognize. The router rejects the message as malformed
and dead-letters it — losing the very delivery the schedule was supposed to
make. An envelope producer shipping ahead of its consumer is unsafe whenever
the consumer validates strictly (allowlist/schema), which is otherwise the
correct, safer default.

## Solution

`cronLambda.node.addDependency(routerLambda)` in the CDK stack, so
CloudFormation updates the consumer (router) before the producer (cron) on
every deploy.

## Prevention

- When one Lambda produces a message/envelope that another Lambda parses
  strictly, add an explicit CDK `addDependency` so the consumer always
  updates first — don't rely on CloudFormation's default resource ordering.
- Check the dependency direction for cycles before adding it (here: the
  router does not reference the cron, so the edge is one-directional and
  safe).
- This generalizes beyond SQS: any producer/consumer pair split across
  Lambdas in the same stack, where the consumer validates strictly, needs
  the same ordering guard.
