---
title: Nexus keeps a new conversation's id in React state, not the URL — E2E reload must navigate to ?id=
category: test-failures
tags:
  - e2e
  - playwright
  - nexus
  - conversation-id
severity: medium
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

An E2E spec (`tests/e2e/nexus-download-file.functional.spec.ts`) that captured
`page.url()` after the first turn and reopened that URL landed on a blank
conversation instead of the one with the first turn's messages.

## Root Cause

Nexus assigns the new conversation's id via
`applyConversationHeader -> onConversationIdChange`, which sets React state —
it never pushes the id into the URL on first message send. `page.url()`
captured right after that turn is still the bare `/nexus` URL.

## Solution

Capture the conversation id from the response/state directly, then navigate
explicitly to `/nexus?id=<uuid>` to reopen it, instead of relying on
`page.url()`.

## Prevention

Any Nexus E2E spec that needs to "reopen" a conversation mid-test must track
the conversation id from state/response data and build the `?id=` URL itself
— don't assume the URL reflects the active conversation after the first send.
