---
title: Assert the serialized request body against the vendor's raw limit
category: testing
tags: [google-chat, byte-budget, vendor-docs, regression-test, agent-router]
severity: medium
date: 2026-09-25
source: auto — PR #1845 (fix/chat-delivery-byte-budget)
applicable_to: project
---

## What Happened

While building the byte-aware truncation for Google Chat replies (PR #1845),
the first version of the byte reservation for a card (`cardsV2`) counted only
the card's own JSON and overshot the real request size by 12 bytes — because
the reservation didn't account for the field-name and structural scaffolding
Google's API adds around the card in the final request body.

## Root Cause

Reservation math was written against "how big is this piece of data," not
"how big is the actual bytes-over-the-wire request." Those differ by the JSON
key names, braces, and array wrapper the API payload adds. A unit test that
only checked the reservation constant against the card size would have passed
while still overshooting Google's real 32,000-byte combined limit.

## Solution

Write the regression test to serialize the *actual outgoing request body*
(prose + cards + accessory widgets, exactly as constructed for the Google Chat
API call) and assert its byte length against the vendor's stated limit
directly, not against an internal reservation constant.

## Prevention

- Before building logic on a numeric vendor limit, verify it against the
  vendor's own docs (in this case, developers.google.com/workspace/chat —
  32,000 bytes for text + cards combined, not per-field), and treat it as a
  falsifiable assumption until confirmed.
- For any budget/cap enforced against a serialized wire format, test against
  the actual serialized bytes of the real payload, not an internal proxy
  quantity — the proxy can drift from the wire format by exactly the amount
  of scaffolding the format adds.
