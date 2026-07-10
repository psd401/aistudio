---
title: CDK-synth-test a heavy construct (EcsServiceConstruct) without triggering a Docker asset build
category: test-failures
tags: [cdk, jest, ecs, testing, alb, regression-test]
severity: low
date: 2026-07-10
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1105 (Qualys ALB stickiness-cookie finding) turned out to be a stale duplicate of #878/#1009, already fixed in prod via PR #879 (confirmed live with `curl -sI https://aistudio.psd401.ai/` — no AWSALB/AWSALBCORS cookies). Deliverable was a CDK synth regression test (`infra/test/unit/ecs-service-stickiness.test.ts`) to lock in that fix so stickiness can never silently regress back onto the target group.

## Root Cause

`EcsServiceConstruct` normally builds a Docker image via `ContainerImage.fromAsset()` during synth, which is slow/heavy and unsuitable for a fast unit test. Also hit a jest/vitest API mismatch: `expect(value, message)` (two-arg form) is Vitest-only and fails to compile under ts-jest (TS2554) — jest's `expect()` takes one argument.

## Solution

- Instantiate the construct with `dockerImageSource: 'fromEcrRepository'` to skip `ContainerImage.fromAsset()` entirely — synth stays fast and asset-free.
- Secret props passed to the construct need well-formed **complete** ARNs — `Secret.fromSecretCompleteArn` requires the 6-char random suffix (e.g. `...:secret:name-AbCdEf`), a bare/partial ARN throws at synth time.
- CDK synthesizes `stickiness.enabled: "false"` explicitly on a disabled target group (the key is present, not absent) — assert on the value, not just key-absence.
- Use jest's one-arg `expect(value)` only; two-arg `expect(value, message)` is a Vitest-ism.

## Prevention

- When synth-testing any construct that normally builds a Docker asset, check for a source-selection prop (`dockerImageSource`/similar) before reaching for mocks or `jest.mock('aws-cdk-lib')`.
- When writing a regression test for a security/scanner finding, assert on the exact synthesized CFN attribute value, not just presence/absence of a key.
- Also: don't commit live production `Set-Cookie` values into verification artifacts — redact token payloads, keep only cookie names + flags (flagged by review on this PR).
