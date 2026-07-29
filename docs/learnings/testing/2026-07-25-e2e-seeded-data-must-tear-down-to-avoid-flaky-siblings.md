---
title: E2E specs that seed data must tear it down — accumulated rows made an unrelated spec flaky
category: testing
tags:
  - e2e
  - playwright
  - test-hygiene
  - atrium
severity: low
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

An E2E spec created library/document rows as test fixtures but never cleaned them
up. Accumulated rows across repeated runs made an unrelated library spec (list
counts, ordering, pagination assumptions) flaky.

## Root Cause

Seed-only specs leak state into shared test infrastructure (local/CI DB) when
there's no explicit teardown step, and other specs that assume a bounded/clean
data set start failing intermittently as the leaked rows accumulate.

## Prevention

- Any E2E spec that seeds data (creates documents, libraries, users, etc.) must
  delete/reset that data in an `afterEach`/`afterAll`, not just rely on the next
  full DB reset.
- Specs asserting on list counts/ordering are especially sensitive to leaked
  fixtures from other specs — treat flakiness there as a signal to check for
  missing teardown elsewhere, not just in the failing spec itself.
