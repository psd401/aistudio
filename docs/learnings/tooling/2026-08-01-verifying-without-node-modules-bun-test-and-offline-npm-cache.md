---
title: Verifying a change with no node_modules — bun test runs dependency-free suites natively, and npm --prefer-offline can still supply tsc
category: tooling
tags:
  - sandbox
  - bun-test
  - npm-cache
  - typecheck
  - verification
  - node-modules
severity: low
date: 2026-08-01
source: auto — /lfg (issue #1525, PR #1532)
applicable_to: project
---

## What Happened

Working PR #1532 in a sandbox where `bun install` / `npm install` against
`registry.npmjs.org` was blocked (the network condition already recorded in
`docs/learnings/workflow/2026-07-05-infra-agent-image-excluded-from-root-gates-plus-sandbox-network-block.md`),
so `bun run lint` / `typecheck` / `test:ci` were all unrunnable. The change was
a pure-TypeScript string sanitizer with zero runtime dependencies — exactly the
kind of code that *can* be verified without a package tree, if you stop trying
to restore the full toolchain.

## Root Cause

Both usual verification paths assume an installed `node_modules`: jest resolves
its transform chain from it, and `tsc` is a devDependency binary inside it.
Neither assumption is load-bearing for a dependency-free module.

## Solution

Two independent escapes, both worth remembering:

1. **`bun test` runs dependency-free suites natively.** Bun's built-in runner
   needs no `node_modules` at all and provides `describe`/`test`/`expect`, so a
   suite whose only imports are the module under test and `node:*` builtins runs
   as-is. (Caveat, and the reason this is a fallback not a default: `bun test`
   is *not* jest — see
   `docs/learnings/tooling/2026-02-18-bun-test-native-runner.md`. It ignores
   `jest.config.js` and diverges on jest-specific APIs, so use it to get signal,
   not to claim the CI gate passed.)

2. **`npm install --prefer-offline` can pull `typescript` + `@types/node` out of
   the local npm cache** even when the registry itself is unreachable, into a
   throwaway directory:

   ```bash
   mkdir -p /tmp/tc && cd /tmp/tc
   npm install --prefer-offline typescript @types/node
   ```

   Then point a hand-written `tsconfig.json` at the specific modules under
   change with `"strict": true`, and add a small **call-site probe** file that
   exercises the new exports with the real argument types — a bare
   `tsc --noEmit` over a module only checks the module's internals, while the
   probe is what actually catches a signature or generic-constraint mistake at
   the boundary the caller will hit.

## Prevention

- When the toolchain can't be installed, first classify the change: does the
  code under test have runtime dependencies? If not, don't spend time reviving
  `bun install` — go straight to `bun test` + a scratch-dir `tsc`.
- Always check `npm install --prefer-offline` (and `--offline`) before
  concluding a blocked registry means no packages at all; the local cache
  frequently already holds `typescript` and `@types/node`.
- Report this verification honestly: "types check under strict + native bun-test
  run of the dependency-free suite; root lint/typecheck/test:ci unrunnable in
  this environment" — not "verified". CI is still the authority.
