---
title: npm to bun migration cascades into Dockerfile, all CI workflows, and internal scripts
category: devops
tags:
  - bun
  - npm-migration
  - dockerfile
  - ci-github-actions
  - lockfile
  - ai-sdk
  - dependency-management
severity: high
date: 2026-02-18
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #785 (issue #775) migrated the project from npm to bun alongside an AI SDK update. The lockfile swap from `package-lock.json` to `bun.lock` triggered required changes across Dockerfile, two CI workflows, and package.json scripts — plus removal of the stale `package-lock.json` from the working directory.

## Root Cause

A lockfile change is not isolated to the install step. Every layer that references the lockfile, the package manager binary, or install/run commands must be updated atomically. Missing any one of these breaks CI or Docker builds silently.

## Solution

Full checklist for npm → bun migration:

1. **Dockerfile** — swap base image to `oven/bun:1.2-alpine` for the `deps` stage; update `COPY package-lock.json` → `COPY bun.lock`; update cache mount path from `/root/.npm` to `/root/.bun`; `builder` and `runner` stages can stay on `node:22-alpine` (bun binary not needed at runtime)
2. **CI workflows** — replace `actions/setup-node` install step with `oven-sh/setup-bun@v1`; replace `npm ci` with `bun install --frozen-lockfile`; replace all `npm run <script>` with `bun run <script>`
3. **package.json scripts** — scan for any scripts that internally call `npm run` and update them
4. **Remove stale lockfile** — delete `package-lock.json` from the repo to prevent tooling confusion
5. **Version pinning** — pin Docker bun image to the same minor version as CI `bun-version` pin (e.g., both at `1.2`) to prevent silent drift; prefer `1.2-alpine` over `1-alpine`

`infra/` subdirectory intentionally kept on npm (separate workspace) — add an inline comment to `infra/package.json` to prevent future confusion.

## Prevention

- Before merging any package manager migration PR, audit: Dockerfile base images + COPY lines, all `.github/workflows/*.yml` files, and all `package.json` scripts for references to the old manager
- Keep Docker image version pin aligned with CI `bun-version` pin — document this pairing in a comment
- Run a security audit as part of PR review: action SHA pinning, cache configuration, and internal script references
