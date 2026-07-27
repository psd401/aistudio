---
title: An import-graph regression guard must be rooted at the real entrypoint, not a convenient leaf
category: workflow
tags:
  - regression-test
  - static-analysis
  - edge-runtime
  - code-review
  - test-design
severity: medium
date: 2026-07-26
source: auto — /lfg (PR #1350, issue #1297)
applicable_to: project
---

## What Happened

`tests/unit/lib/auth/edge-refresh-boundary.test.ts` was written to catch
Node-only imports (`winston`, `@aws-sdk/*`, `node:*`) leaking into the Edge
middleware bundle — the exact class of bug issue #1297 was about. The first
version rooted its breadth-first import walk at `lib/auth/token-refresh-client.ts`
(the module directly involved in the bug), not at `middleware.ts` (the actual
Next.js Edge compilation entrypoint). Two independent parallel reviewers
(security and correctness passes) flagged that the guard could not detect a
violation introduced anywhere between `middleware.ts` and its `auth.ts` →
token-refresh-client import chain — i.e., it could not have caught the very bug
it was written for if the forbidden import had entered via a different file in
that chain.

## Root Cause

The guard's author picked the module they had just fixed as the root, which
feels natural ("this is where the bug was") but is the wrong graph to walk. The
thing that determines what actually gets bundled for Edge is the Next.js
compilation entrypoint (`middleware.ts`), not the file where a fix landed. A
regression guard rooted below the true entrypoint only re-verifies the fixed
file's own imports — it does not guard the graph an attacker/future-editor
would actually change.

## Solution

Root the walk's `ENTRIES` array at every file Next.js actually compiles for the
runtime in question, then include the module of interest for narrower failure
messages if it's already reachable from one of those entries:

```ts
// Real Edge entrypoints Next.js compiles, plus the module of interest so a
// failure names the narrowest graph it can.
const ENTRIES = ["middleware.ts", "auth.ts", "lib/auth/token-refresh-client.ts"]
```

## Prevention

- When writing an import-graph / dependency-boundary regression test, ask
  "what does the *bundler/runtime* actually compile as an entrypoint?" — not
  "what file did I just fix?" Root the walk there.
- If a new file becomes reachable from that entrypoint later, add it to the
  guard's entry list rather than assuming the existing root still covers it.
- Treat "would this guard have caught the bug it was written for, if the bad
  import had landed one hop further upstream?" as a review question for any
  regression test targeting an import graph.
