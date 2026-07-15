---
title: Bundling an app-tree TS handler into a CDK Lambda — SOURCE hash + local esbuild, not fromAsset OUTPUT
category: infrastructure
tags: [cdk, lambda, esbuild, assetHashType, bundling, fromAsset, agent-workspace]
severity: medium
date: 2026-07-15
source: auto — /work
applicable_to: project
---

## What Happened

PR #1236 (#1232) added a new `psd-agent-mint-{env}` Lambda whose handler (`lib/agent-workspace/mint-lambda-handler.ts`) lives in the Next.js app tree, not under `infra/`, so it can share the broker/sheet-writer modules and their existing jest unit tests.

## Root Cause

`lambda.Code.fromAsset` needs to know both how to bundle app-tree TypeScript (esbuild, path aliases, external packages) and how to hash the asset for change detection. Getting either wrong either breaks CDK unit tests (which synth with bundling disabled) or produces a stale/incorrect deploy hash.

## Solution

In `infra/lib/agent-platform-stack.ts`:
- Point `lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lib', 'agent-workspace'), ...)` at the app source directory.
- Set `assetHashType: cdk.AssetHashType.SOURCE` (repo convention — every existing agent Lambda uses this) — NOT `OUTPUT`. `OUTPUT` misbehaves/throws when CDK unit tests synth with bundling disabled (`aws:cdk:bundling-stacks: []`), since there is no output to hash yet.
- Bundle via `bundling.local.tryBundle(outputDir)`, invoking the repo-root esbuild binary directly (`node_modules/.bin/esbuild`) rather than the Docker bundling image: `--bundle --platform=node --target=node22 --format=cjs --outfile=<outputDir>/index.js --tsconfig=<repoRoot>/tsconfig.json --external:@aws-sdk/*`.
- Resolve the `@/*` path alias via `--tsconfig=<repo>/tsconfig.json` (matches app import style).
- Mark `@aws-sdk/*` external — it's present in the Node 20/22 Lambda runtime, no need to bundle it.
- Bundle `google-auth-library` and `winston` inline (not present in the runtime).
- The Docker `bundling.command` fallback intentionally fails loud (`exit 1` with a message) rather than attempting a bundle — the small `lib/agent-workspace` asset dir alone can't produce a correct bundle without the repo-root esbuild/tsconfig, so local bundling is the required path (consistent with other agent Lambdas).

## Prevention

- Before wiring the CDK construct, manually run the exact esbuild command and load the resulting bundle in `node` to confirm it resolves correctly — cheaper than debugging a bad synth/deploy.
- When adding a new app-tree-backed Lambda, grep other agent Lambdas in `agent-platform-stack.ts` for the same `tryBundle`/`assetHashType: SOURCE` pattern rather than re-deriving it.
