---
title: Editing lib/capabilities/manifest.ts requires regenerating the committed catalog
category: build-errors
tags:
  - capabilities
  - ci
  - drift-gate
  - generated-artifacts
  - bun-scripts
severity: medium
date: 2026-07-24
source: auto — /work
applicable_to: project
---

## What Happened

A copy-only edit to `lib/capabilities/manifest.ts` (dropping "and schedule" from a
description string, #1322/PR #1323) left `docs/API/v1/generated/capability-catalog.json`
stale. CI's "Test, Lint, and Type Check" job runs `bun run capabilities:check`
(`scripts/capabilities/generate-catalog.ts --check`) as a drift gate, which fails the
build when the generated file doesn't match what the manifest would produce.

## Root Cause

`capability-catalog.json` is a generated artifact committed to the repo (like the
tool-catalog OpenAPI spec checked by the same CI job). Any change to
`lib/capabilities/manifest.ts` — even one that doesn't change behavior — changes the
generator's output, and the `--check` flag diffs the committed file against a fresh
generation rather than regenerating it in CI.

## Solution

After any edit to `lib/capabilities/manifest.ts`, run `bun run capabilities:generate`
and commit the resulting diff to `docs/API/v1/generated/capability-catalog.json`
before pushing.

## Prevention

Treat `lib/capabilities/manifest.ts` like `lib/tools/catalog/manifest.ts` /
`docs/API/v1/openapi.yaml` — any edit requires a paired regeneration step
(`capabilities:generate`) before commit. CI's `capabilities:check` step in
`.github/workflows/ci.yml` will catch a missed regeneration, but catching it locally
first avoids a failed CI run on an otherwise-trivial copy edit.
