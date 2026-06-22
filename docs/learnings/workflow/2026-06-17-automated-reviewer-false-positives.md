---
title: Automated code reviewers emit confident false positives — always verify against source
category: workflow
tags:
  - pr-review
  - false-positives
  - eslint-config
  - typescript-narrowing
  - code-review
  - verification
severity: high
date: 2026-06-17
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1038 (tool catalog unification + per-surface scopes) received an automated code review with 7 findings, including a "P1 blocker" claiming `console.*` usage in `scripts/openapi/generate-from-catalog.ts` required `eslint-disable` comments. The claim was wrong — `eslint.config.mjs` Rule 5 already sets `no-console: off` for `scripts/**/*.ts`. CI lint was green throughout. Two other findings were also false positives: a "dead code" claim about `entry.version ?? v1` (ignored that `ToolManifestEntry.version` is optional, not always-defined), and a claim about remaining `.tool` consumers (a grep returned zero results).

## Root Cause

LLM-based reviewers frequently pattern-match on surface signals (e.g., `console.log` present → must add eslint-disable) without reading the actual eslint config or type definitions. Severity labels like "P1 blocker" are generated heuristically and carry no guarantee of correctness.

## Solution

For each finding, verify against the actual source before acting:
- **Lint claims**: Check `eslint.config.mjs` glob overrides; run `bun run lint` to confirm.
- **Dead code / optional-field claims**: Check the TypeScript interface/type definition directly.
- **"Remaining consumers" claims**: Run a real grep against the codebase.
- **Valid finding**: The `as string[]` cast in `requiredScopesForSurface` was real — hoisting the lookup to a local variable enabled TS narrowing and removed the cast.

## Prevention

- Treat automated review severity labels as suggestions, not facts.
- Before changing code in response to a review finding, run the relevant verification command (lint, typecheck, grep) and read the relevant config/type file.
- A green CI pipeline is stronger evidence than a reviewer's severity label.
