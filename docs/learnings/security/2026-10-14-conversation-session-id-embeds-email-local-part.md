---
title: scheduledConversationSessionId is not opaque — it embeds the staff email local part; verify "consistent with existing practice" claims before asserting them
category: security
tags:
  - logging
  - pii
  - session-id
  - agent-platform
  - cloudwatch
  - sanitize-for-logging
severity: high
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

While building thread→conversation-session resolution for replies to scheduled posts (issue
#1891 / PR #1913), a log statement printed the `scheduledConversationSessionId` on the
assumption it was as opaque as every other session id in the surrounding code (which are all
produced by `scopedAgentSessionId`, a hash). A PR reviewer checked and found this false.

## Root Cause

Most session ids in this stack go through `scopedAgentSessionId`, which hashes its input and is
safe to log. `scheduledConversationSessionId` is built differently: it embeds
`workspacePrefix.substring(0, 40)`, and `workspacePrefix` is `${emailLocalPart}-${uuidSuffix}`.
So this one session id carries a readable staff email local part straight into CloudWatch,
while every other session-id log call nearby looks structurally identical and is hashed — the
field name gives no visual cue that it's different.

Separately, when defending the original log call in review, the claim "cron already logs this
same raw id elsewhere" was asserted without grepping — the reviewer checked and found cron
actually logs the runtime session id (hashed), not this one.

## Solution

Hash or drop `scheduledConversationSessionId` before logging it, same as every other session id
in this code path.

## Prevention

- When a codebase has one hashing convention for an entire class of identifier (session ids via
  `scopedAgentSessionId`), audit every value with "session id" in its name for whether it
  actually went through that helper — don't assume by naming pattern alone.
- Before writing "this is consistent with existing practice" in a PR comment or code comment,
  grep the actual call sites and confirm it — don't assert it from memory.
