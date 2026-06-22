---
title: Bridging web→infra pipelines — ECS IAM/env must be explicit, DB stays in Drizzle
category: workflow
tags:
  - skills
  - assistant-architect
  - skill-md
  - drizzle
  - onConflictDoUpdate
  - targetWhere
  - ecs-iam
  - ssm
  - s3
  - lambda-invoke
  - eslint-ignore
  - cdk-synth
  - issue-925
  - epic-922
  - epic-910
severity: high
date: 2026-06-16
source: auto — /work
applicable_to: project
---

## What Happened

Implemented the "Publish as Skill" slice of Issue #925 connecting the web Assistant Architect to the existing infra SKILL.md scan pipeline. The web app needed to upload a SKILL.md to S3, register a draft row in `psd_agent_skills`, then async-invoke the skill-builder Lambda — mirroring exactly what `infra/agent-image/skills/psd-skills-meta/common.js` does.

## Root Cause

The frontend ECS task had no awareness of the agent workspace bucket or skill-builder Lambda. Neither env vars nor IAM grants are inherited automatically — they must be added explicitly in `infra/lib/constructs/ecs-service.ts`.

## Solution

- **DB writes**: Stay in Drizzle via direct postgres.js connection — no RDS Data API needed. Used `onConflictDoUpdate` with `targetWhere` (supported in drizzle-orm 0.45.1) to match a partial unique index (`WHERE scope='draft'`).
- **ECS env vars**: Added `AGENT_WORKSPACE_BUCKET` (resolved from SSM `/aistudio/{env}/agent-workspace-bucket-name`) and `SKILL_BUILDER_LAMBDA_ARN` (deterministic ARN constructed at synth time) to the env map in `ecs-service.ts`.
- **ECS IAM**: Added `lambda:InvokeFunction` on the skill-builder ARN and `s3:PutObject`/`s3:GetObject` scoped to `skills/*` prefix in the agent workspace bucket — both as explicit policy statements in `ecs-service.ts`.
- **S3 path + tags**: Mirrors infra author flow: `skills/user/{email}/drafts/{slug}/SKILL.md` with required S3 tags so the skill-builder Lambda recognises the object.
- **Validated**: `bunx cdk synth AIStudio-FrontendStack-ECS-Dev -c baseDomain=...` clean before shipping.

## Prevention

- Any time the web app touches a new AWS resource (S3 bucket, Lambda, SSM param), update `infra/lib/constructs/ecs-service.ts` with both the env var and the IAM grant — it is never automatic.
- When mirroring an infra-side pipeline in the web app, read the infra script first (`common.js` or equivalent) to match S3 key structure and tags exactly.
- `eslint`'s "File ignored because of a matching ignore pattern" on `*.test.ts`, `*.spec.ts`, and infra files is config-by-design (`eslint.config.mjs`) and exits 0 under `--max-warnings 0` — not a code warning to fix.
