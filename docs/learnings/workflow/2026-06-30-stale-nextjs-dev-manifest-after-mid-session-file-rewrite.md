---
title: Long-lived Next dev server can serve a stale route after a mid-session merge rewrites the file
category: workflow
tags:
  - nextjs
  - dev-server
  - playwright
  - e2e
  - docker
  - stale-cache
severity: medium
date: 2026-06-30
source: auto — /lfg
applicable_to: project
---

## What Happened

During PR #1088 verification, an E2E Playwright guard hit `DELETE .../publish/[destination]` and got a 404 instead of the expected 401 on the long-lived local Docker dev server (`:3000`). A freshly-started host `bun run dev` on `:3100` correctly returned 401 for the same route.

## Root Cause

Next.js dev mode compiles routes on-demand and caches the route manifest. The route file had been rewritten mid-session by a merge; the long-lived server's cached manifest entry for that specific file went stale, while sibling routes (compiled fresh after the merge) worked correctly. This is distinct from [[prepush-docker-3000-prod-build-rejects-dev-auth-run-3100]] (that one is a prod-build cookie-auth rejection; this one is a stale dev-mode manifest cache) — same symptom location (`:3000` vs `:3100`), different root cause.

## Solution

Verified the route against a freshly-started server instead of the long-lived one. CI, which always does a fresh build/checkout, is authoritative and was not affected.

## Prevention

- After any mid-session file rewrite (merge, rebase, hot-patch) that touches a route file, don't trust a long-lived Next dev server's response for that route — restart it or verify against a fresh server/CI build first.
- If a route behaves correctly on some paths but not others after a merge, suspect a stale on-demand-compilation cache before suspecting the code itself.
