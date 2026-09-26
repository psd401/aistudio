---
title: Recompose a retried payload from an allow-list, not the parsed envelope
category: architecture
tags: [chat-delivery, google-chat, dead-letter, allow-list, deny-list, agent-router, agent-cron]
severity: high
date: 2026-09-25
source: auto — PR #1845 (fix/chat-delivery-byte-budget)
applicable_to: project
---

## What Happened

Fixing the Google Chat byte-budget bug (PR #1845), the durable-outbox retry path
dead-lettered every reply on redelivery even though the primary send had
succeeded. Root cause: `recomposeRichText()` re-serialized the *entire parsed*
rich envelope object to build the canonical outbox text, rather than the
specific fields the caller actually forwarded to the Google Chat API.

## Root Cause

`extractRichEnvelope` casts any JSON object embedded in the reply to
`RichEnvelope` — it has no schema enforcement. The byte reservation
(`reservedBytes`) was computed only from the fields sent to Google
(`cardsV2`/`accessoryWidgets`/`actionResponse`), but the re-wrap for the retry
queue serialized the whole parsed object. A model-invented `textFallback`
property (never sent to Google, never budgeted) rode along in the re-wrap: the
primary call fit and succeeded, the re-serialized retry payload did not fit the
same bound, and it failed on every dequeue attempt until it dead-lettered.

The first attempt at a fix removed `textFallback` by name — a deny-list. Review
caught that this doesn't generalize: any other unbudgeted property the model
invents reproduces the same failure under a different key. Deny-listing the bug
you found, rather than the shape of the bug, still leaves silent delivery
failures for anything not yet observed. This same defect independently smuggled
`actionResponse` into agent-cron retries, which never forwards that field on
its own delivery path — so the redelivered message didn't even match the first
attempt.

## Solution

Recompose the retry/outbox payload from exactly the fields the caller forwarded
to the API (`richParts`) — an allow-list — rather than re-serializing whatever
was parsed out of the model's reply. The reservation calculation and the
re-wrapped payload must be derived from the *same* object, not independently
computed from two different representations of "the envelope."

## Prevention

- When a payload is parsed from untrusted/model-generated JSON and then
  reforwarded to a second consumer (a retry queue, a cache, a log sink), treat
  "what fields exist" as adversarial. Prefer an allow-list of forwarded fields
  over a deny-list of known-bad ones.
- When two code paths (primary send vs. retry) both need "the same message,"
  derive both from one canonical object built once, not by independently
  re-deriving each from a shared parse step — divergence there fails silently
  (accepted once, rejected forever after).
