---
title: Atrium collection requiresApproval is UPDATE-only on the REST surface; scope is required on create
category: testing
tags:
  - atrium
  - rest-api
  - collections
  - requiresApproval
  - test-fixtures
severity: low
date: 2026-09-03
source: /lfg #1726 (PR #1732)
applicable_to: project
---

## What Happened

Setting up an E2E fixture for a review-gated Atrium collection (`requiresApproval:
true`) as part of issue #1726, a single POST with `requiresApproval` in the body
returned **400**, and so did the retry without it.

Two separate causes, both in `createCollectionBodySchema` (`lib/content/rest.ts`):

1. The schema is `.strict()` and does not list `requiresApproval` — it is on
   `updateCollectionBodySchema` only, deliberately ("review is turned on for a
   section that already exists"). An unknown key is rejected, so the collection is
   NOT created with the flag silently dropped; the whole request fails.
2. `scope` (`"district" | "private"`) is REQUIRED on create. There is no default.

The 400 body names the offending field, which is the fast way to tell these apart.

## Solution

Create the collection with POST (including a valid `scope`), then PATCH it to set
`requiresApproval: true`. A single POST cannot produce a review-gated collection.

## Prevention

- When scripting a test fixture for an Atrium collection that needs
  `requiresApproval`, POST then PATCH — the update schema is create's schema plus
  several update-only fields (`archived`, `description`, `landingObjectId`,
  `requiresApproval`), so "update accepts it" says nothing about create.
- Always include `scope` on collection create; it is required, not optional with a
  safe default.
- A `.strict()` zod body schema fails the WHOLE request on an unknown key rather than
  ignoring it — so a field that belongs to the update schema is a 400 on create, not
  a silently-dropped value. Read the 400 body rather than guessing which field.
