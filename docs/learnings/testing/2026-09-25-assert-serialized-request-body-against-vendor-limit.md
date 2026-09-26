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

Two changes, and the order matters — the failing test came first:

1. The regression test was written against the *assembled request*, not against
   the reservation constant: it measures the delivered text plus the card payload
   and asserts the total against the vendor's stated limit. That is what surfaced
   the 12-byte overshoot; a test comparing the reservation to the card size alone
   would have passed.
2. The reservation was then widened to
   `JSON.stringify({ ...richParts, text: '' })`, which prices the field names,
   braces and array wrappers as well as the card itself.

A later review round pushed this further, and was right to. My first instinct was
that asserting `JSON.stringify(messageBody)` would be a stricter-but-wrong bar,
because Google's limit reads as being on message *content* while JSON escaping
inflates the text field (a newline becomes `\n`, two bytes for one). The numbers
settled it: `'a\n'.repeat(16_000)` is 32,000 UTF-8 bytes and serializes to
48,000. Budgeting the decoded length "fitted" that reply to exactly the limit and
would have had Google reject the assembled request outright — and a rejection
loses the *entire* response and then dead-letters every durable retry of it,
which is strictly worse than truncating the reply. So the budget is now spent in
serialized bytes (`wireBytes`), plus a held-back allowance for request fields
spliced in after the fit (`thread`), and the test asserts the fully assembled,
serialized body.

The general lesson: when you cannot confirm which side of an encoding boundary a
vendor measures, pick the accounting whose failure mode is graceful. Over-counting
delivers a few percent less text; under-counting loses the whole message.

## Prevention

- Before building logic on a numeric vendor limit, verify it against the
  vendor's own docs and quote it in the code. Here,
  developers.google.com/workspace/chat/create-messages states verbatim: "The
  maximum message size (including any text or cards) is 32,000 bytes." It is one
  combined budget, not a per-field ceiling — which is exactly why a reservation
  model is needed rather than a fixed cap on the text field. An adversarial
  review flagged this figure as an unverified assumption; it happened to be
  right, but nothing in the branch had established that.
- For any budget enforced against an assembled payload, test the assembled
  payload, not an internal proxy quantity — the proxy drifts from the real thing
  by exactly the scaffolding the format adds.
