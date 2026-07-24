---
title: Codex's clean verdict posts as an issue comment, not a formal review
category: workflow
tags:
  - pr-review
  - ai-reviewers
  - codex
  - gemini
  - copilot
  - ci
severity: low
date: 2026-07-24
source: auto — /work
applicable_to: project
---

## What Happened

On PR #1323 (~20,600 changed lines), the three configured bot reviewers behaved
differently than a script polling only the PR reviews API would expect:
- **Copilot** posted a formal review (`state: COMMENTED`) whose body was just:
  "Copilot wasn't able to review this pull request because it exceeds the maximum
  number of lines (20,000)."
- **Gemini Code Assist** posted an issue comment (not a review):
  "The consumer version of Gemini Code Assist on GitHub has been sunset. All code
  review activity has officially ceased." — it never produces reviews anymore.
- **Codex** posted formal reviews with findings on earlier pushes (each pinned to the
  commit that triggered it), but its final clean pass was an **issue comment**
  ("Codex Review: Didn't find any major issues. Keep it up!"), not a PR review object.

## Root Cause

The three bots don't share a common signaling channel. A findings-bearing Codex review
is a GitHub PR review; a clean Codex verdict is a plain issue comment. Gemini's
sunset notice is also a plain issue comment, easily mistaken for "no signal yet."
Copilot's size-limit refusal looks identical in shape to a real review (`COMMENTED`
state) but contains no actual findings.

## Solution

When polling for AI reviewer status, check **both** the PR reviews API and the issue
comments API, and match on body text (Codex's "Didn't find any major issues" /
Gemini's "sunset" / Copilot's "exceeds the maximum number of lines") rather than
assuming "a review object exists" == "a real review happened."

## Prevention

- Don't treat an absent Codex *review* as "not done yet" — check issue comments for a
  clean-verdict comment before assuming it's still pending.
- Don't treat a Copilot `COMMENTED` review as a real pass — read the body; >20,000
  changed lines gets an automatic skip message.
- Don't wait on Gemini for signal on any PR — it no longer reviews, full stop.
- Builds on [[ai-reviewer-retrigger-conditions-differ-per-bot]] (trigger conditions)
  and [[ai-reviewer-bots-review-trigger-commit-not-head]] (staleness) — this adds the
  *response channel* (review vs. issue comment) each bot uses for a clean/skipped
  result, verified via the GitHub API on PR #1323.
