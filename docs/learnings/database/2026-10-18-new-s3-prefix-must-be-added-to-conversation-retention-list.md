---
title: A new conversation-scoped S3 prefix must be added to the retention Lambda's sweep list
category: database
tags:
  - s3
  - retention
  - nexus
  - lambda
severity: high
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

Adding generated documents as a new conversation-scoped S3 prefix required
adding it to `conversationStoragePrefixes()` in
`infra/lambdas/nexus-conversation-retention/index.ts`. This was caught in
adversarial review, not by any test.

## Root Cause

`claimConversation` deletes the conversation DB row before sweeping its S3
objects; after that, `findCandidates` can never surface that conversation id
again. Any S3 prefix not listed in `conversationStoragePrefixes()` at the time
the row is deleted leaks its objects permanently — there is no second chance.

## Solution

Every feature that writes conversation-scoped objects to S3 under a new
prefix must register that prefix in `conversationStoragePrefixes()` in the
same change.

## Prevention

Treat `conversationStoragePrefixes()` as a checklist item whenever a new
conversation-scoped S3 write path is added — grep for it before shipping, and
consider a lint/test that enumerates known write-path prefixes against it
since nothing currently catches an omission automatically.
