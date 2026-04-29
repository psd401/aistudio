---
title: AI Reviewer Bots Review Trigger Commit, Not HEAD
category: code-quality
tags:
  - pr-review
  - ai-reviewers
  - incremental-review
severity: low
date: 2026-03-12
source: auto — /review-pr
applicable_to: project
---

## What Happened

During incremental review of PR #861, all 3 inline bot reviewer comments (GitHub Copilot, Codex, Gemini) flagged an old sentinel pattern. That pattern had already been fixed in a later commit pushed before the bots posted their reviews.

## Root Cause

AI reviewer bots are triggered on a specific commit event (e.g., `push`) and begin analysis at that point. By the time the review is posted, the HEAD may have advanced. The bots review the commit that triggered them — not the current HEAD.

## Solution

No action needed when bot comments reference code that is already fixed — confirm the fix is present at HEAD and dismiss/resolve the comments with a note explaining the timing gap.

## Prevention

In incremental review runs, expect bot comments to be 1–2 commits stale when fixes were pushed in rapid succession. Before acting on any bot inline comment, check whether the flagged code still exists at HEAD (`git show HEAD:path/to/file`). Do not re-fix already-fixed code based on delayed bot feedback.
