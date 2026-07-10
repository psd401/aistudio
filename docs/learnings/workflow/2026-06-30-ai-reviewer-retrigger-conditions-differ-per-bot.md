---
title: AI PR reviewers don't all re-review on plain push — know each bot's trigger condition
category: workflow
tags:
  - pr-review
  - ai-reviewers
  - codex
  - gemini
  - copilot
  - ci
severity: low
date: 2026-06-30
source: auto — /lfg
applicable_to: project
---

## What Happened

During PR #1088, follow-up pushes did not reliably produce fresh reviews from every configured bot. Codex (`chatgpt-codex-connector`) does not auto-re-review on a plain push — it only re-reviews on PR open, "ready for review," or an explicit `@codex review` comment, and its findings are pinned to whatever commit SHA triggered it (so a plain push can leave its comments stale relative to HEAD, compounding [[ai-reviewer-bots-review-trigger-commit-not-head]]). Gemini does auto-review on push but is being sunset (consumer version ends July 2026). Copilot can be quota-limited and silently skip a review. The `claude-review` CI job posts a full review but can take 7-15+ minutes on a large diff.

## Root Cause

Each bot integration has a different trigger/refresh policy that isn't documented in one place; assuming "push = all bots re-review" leads to acting on stale findings or waiting on a bot that isn't going to run.

## Solution

Explicitly comment `@codex review` when a fresh Codex pass is needed after substantive pushes; don't wait on Gemini for a fresh signal near/after its July 2026 sunset; budget 7-15+ min for `claude-review` on large diffs before treating its absence as a skip.

## Prevention

- Codex: re-reviews on open/ready-for-review/explicit `@codex review` comment only — trigger it manually after significant pushes.
- Gemini: auto-reviews on push today, but sunsetting (July 2026) — don't build process around it long-term.
- Copilot: can be quota-limited and skip silently — don't treat its absence as "no findings."
- `claude-review` CI: full review, but slow (7-15+ min) on large diffs — don't assume it's stuck.
- Combine with [[ai-reviewer-bots-review-trigger-commit-not-head]]: even a triggered re-review may reference a stale commit if pushes land in rapid succession.
