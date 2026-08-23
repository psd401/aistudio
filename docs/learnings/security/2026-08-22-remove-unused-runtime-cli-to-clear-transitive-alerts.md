---
title: Remove unused runtime CLIs instead of overriding their vulnerable transitives
category: security
tags: [dependabot, aws-lambda, aws-sdk-v2, transitive-dependencies, npm-audit, ci, serverless]
severity: high
date: 2026-08-22
source: auto — /lfg
applicable_to: project
---

## What Happened

Issue #1642 included `aws-sdk` v2, `uuid`, and `js-yaml` alerts from `infra/lambdas/document-processor-v2`; the Lambda used AWS SDK v3 and imported only types from `@types/aws-lambda`.

## Root Cause

The runtime dependency named `aws-lambda` was an unused third-party deployment CLI, not the Lambda runtime API, and its obsolete dependency tree introduced the vulnerable packages.

## Solution

Remove the CLI from `package.json`, regenerate the lockfile, and verify the production graph with `npm audit --omit=dev`; add a package-local install/build/test/audit CI job. Incorporate related security bumps, such as the still-unmerged `aiohttp` 3.14.3 update from PR #1643, before closing an umbrella alert issue.

## Prevention

Before overriding transitive alerts, trace the dependency to a production import or deployment command. Prefer removing an unused root dependency, then keep the graph clean with package-local CI coverage.
