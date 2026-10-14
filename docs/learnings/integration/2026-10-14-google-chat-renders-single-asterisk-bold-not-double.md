---
title: Google Chat renders *bold*, not **bold** — text composed in a Lambda never passes through the model-output converter
category: integration
tags: [google-chat, markdown, agent-schedules, formatting]
severity: low
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

While building the owner-notification Chat DM for #1890, found that every
scheduled post's `📋 **name**` header has been rendering as literal double
asterisks in Google Chat — a pre-existing bug, not something introduced by
this PR.

## Root Cause

Google Chat's message formatting uses a documented subset of Markdown where
bold is a single asterisk (`*bold*`), not CommonMark's `**bold**`.
`infra/agent-image/chat_format.py` already documents this subset and
converts the model's CommonMark output to Chat's dialect — but that
converter sits at the harness boundary (agent output → Chat message). Text
composed directly in a Lambda (e.g. the cron's scheduled-result header) is
constructed as a literal string and never passes through `chat_format.py`,
so it has to already be written in Chat's dialect, not CommonMark.

## Solution

Use `*text*` for bold in any string built directly for a Chat message
outside the agent-output path (Lambdas, skills, scripts) — `infra/agent-image/chat_format.py`
is the reference for the full supported subset.

## Prevention

- Before adding `**bold**`/other CommonMark syntax to a string destined for
  Google Chat, check whether that string is composed directly (Lambda,
  script) or passes through the model-output converter — only the latter
  gets normalized automatically.
- Any hardcoded Chat message string is a candidate for review against
  `infra/agent-image/chat_format.py`'s documented subset.
