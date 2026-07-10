---
title: infra/** is fully excluded from root tsconfig/eslint/jest — and this sandbox couldn't bun install at all
category: workflow
tags:
  - infra-agent-image
  - tsconfig
  - eslint
  - jest
  - ci-gate
  - sandbox-network
  - bun-install
severity: low
date: 2026-07-05
source: auto — /lfg (issue #1106, PR #1109)
applicable_to: project
---

## What Happened

PR #1109 (issue #1106) changed only
`infra/agent-image/skills/psd-data/common.js`/`run.js`. Before spending effort
getting `bun install` working, confirmed via direct grep that `infra/**` is
excluded from the root `tsconfig.json`, `eslint.config.mjs`, AND
`jest.config.js` — the latter has an explicit `/infra/` entry in
`testPathIgnorePatterns` with the comment "Infra has its own Jest config."

Separately (and orthogonally), this sandbox session could not run
`bun install` at all: `node_modules` was completely empty on a fresh
checkout, and `registry.npmjs.org` returned a direct 403 despite being listed
in the agent-proxy's `noProxy` allowlist — meaning some other network-layer
policy blocks it, unrelated to the documented proxy config. This blocked
`bun run lint`/`typecheck`/`build`/`test:ci` entirely, for any diff, not just
this one.

## Root Cause

`infra/` is intentionally a separate workspace with its own tooling config
(see also `docs/learnings/devops/2026-02-18-npm-to-bun-migration-cascade.md`,
which notes `infra/` stayed on npm during the bun migration). The root gates
were never wired to cover it. The Python side of this same exclusion is
already documented in
`docs/learnings/workflow/2026-06-30-python-agent-image-tests-unittest-not-pytest.md`
(unittest, not CI-gated) — this note extends the same "infra/agent-image is
outside the root gate" fact to the JS/TS/jest side.

## Solution

For a change confined to `infra/agent-image/skills/*`, the actual regression-test
convention is a per-directory `bun test` (see `psd-plaud`, `psd-summarize` for
precedent), run manually — not CI-gated, and structurally unaffected by
root build/lint/typecheck/jest regardless of whether those gates can even
run in the current environment.

## Prevention

- Before trying to make root `lint`/`typecheck`/`test:ci` pass for an
  infra/agent-image-only diff, confirm the change is actually in scope for
  those gates — it likely isn't. Check `jest.config.js`
  `testPathIgnorePatterns`, `eslint.config.mjs` ignores, and
  `tsconfig.json` excludes for `/infra/` first.
- If `bun install` fails with a fresh/empty `node_modules` and a 403 from
  `registry.npmjs.org`, don't assume it's the documented agent-proxy — check
  `$HTTPS_PROXY/__agentproxy/status` for per-tool fixes, but also consider a
  separate network-layer block outside proxy config. This can make root
  gates unrunnable for ANY diff in the current environment, not just
  infra-scoped ones — don't burn time debugging it as if it were specific to
  the change at hand.
