---
title: "S3 ListBucket must be granted on bucket ARN, not object-prefix ARN"
category: security
tags:
  - iam
  - s3
  - aws
  - cdk
  - least-privilege
  - listbucket
  - access-denied
  - pr-review
severity: high
date: 2026-06-17
source: auto — /review-pr
applicable_to: project
---

## What Happened

ECS task IAM policy granted `s3:PutObject`, `s3:PutObjectTagging`, and `s3:GetObject` on the agent workspace bucket with an object-prefix ARN (`arn:...:bucket/skills/*`). `s3:ListBucket` was omitted. Every `ListObjectsV2Command` call returned `AccessDenied` at runtime, breaking the skill detail page and zip export. `cdk synth` and deploy both succeeded silently.

## Root Cause

`s3:ListBucket` is a bucket-level action and must be scoped to the bare bucket ARN (`arn:aws:s3:::bucket-name`). Object-level actions (`Get*`, `Put*`, `Delete*`) take the object-prefix ARN (`arn:...:bucket-name/prefix/*`). Granting `ListBucket` on an object-prefix ARN is silently ignored by IAM — the action never matches.

## Solution

Split into two `PolicyStatement` blocks in CDK:

1. **Bucket-level statement** — `s3:ListBucket` on the bucket ARN with an `s3:prefix` `StringLike` condition (`skills/*`) to keep scope narrow.
2. **Object-level statement** — `s3:GetObject`, `s3:PutObject`, `s3:PutObjectTagging` on `arn:...:bucket-name/skills/*`.

Verified via `cdk synth` — confirm the rendered CloudFormation shows separate statements with the correct ARN targets.

## Prevention

- When adding any S3 permissions in CDK, check whether each action is bucket-level or object-level before choosing the ARN.
- Treat missing `ListBucket` as a blocking P1 in PR review whenever `ListObjectsV2` is used anywhere in the code path.
- Run `cdk synth` and inspect the rendered IAM policy JSON — not just the CDK construct — to catch ARN mismatches before deploy.
