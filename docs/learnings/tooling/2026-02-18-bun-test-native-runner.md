---
title: bun test invokes bun's native test runner, not jest — silent failure when jest config present
category: tooling
tags:
  - bun
  - jest
  - migration
  - testing
  - shell-scripts
severity: high
date: 2026-02-18
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #787 review found that scripts calling `bun test` silently invoked bun's native test runner instead of jest, despite jest being configured in `jest.config.ts`. No error was raised — jest config and flags were simply ignored.

## Root Cause

When bun is used as a package manager, `bun test` is a built-in command that runs bun's native test runner. It does NOT delegate to the jest binary configured in `package.json`. This is a dangerous silent fallback.

## Solution

**Always use `bunx jest`** when the project depends on jest as its test framework.

- `bun test` → runs bun's native runner (ignores jest config)
- `bunx jest` → invokes jest binary from node_modules

Update all scripts and CI workflows:
```json
{
  "scripts": {
    "test": "bunx jest",
    "test:watch": "bunx jest --watch",
    "test:coverage": "bunx jest --coverage"
  }
}
```

Also update `.github/workflows/*.yml` files that run tests:
```yaml
- run: bunx jest
- run: bunx jest --coverage
```

## Prevention

- During bun migrations, audit all `bun test` invocations in `package.json` scripts and CI workflows
- If jest config exists (`jest.config.ts`, `jest.config.js`), default to `bunx jest`
- Add a comment in `package.json` scripts section: "Use bunx jest, not bun test, to respect jest config"
- In PR reviews, verify test script points to correct runner by examining `package.json` and `.github/workflows/`
