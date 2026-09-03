---
title: E2E that only opens a creation dialog is not coverage — drive to persistence and read the object back
category: testing
tags:
  - e2e
  - playwright
  - atrium
  - coverage-gap
  - server-actions
  - regression-tests
severity: high
date: 2026-09-03
source: auto — /lfg
applicable_to: project
---

## What Happened

Issue #1714: the Atrium library's "Build it for me" / "Start blank" artifact-creation
flow was completely broken (WAF-blocked, see
`docs/learnings/security/2026-09-03-alb-waf-crosssitescripting-body-blocks-raw-html-content-writes.md`)
in every deployed environment, yet the suite reported green. The #1710 spec
(`atrium-artifact-data-access.functional.spec.ts`) seeds its artifact over REST, and
`atrium-meridian-creation.spec.ts` only asserted that "New page" opened the prompt
dialog. No spec drove either dialog path to a created, persisted object.

## Root Cause

Between them, the existing specs either seeded content over REST (bypassing the
client write path entirely) or only asserted that the creation *dialog* opened — not
that clicking its primary action actually produced a row. A test that opens a dialog
exercises the UI shell but not the write path behind it, so a server action that
silently rejects (WAF, thrown exception, wrong payload shape) never surfaces as a
failure.

## Solution

Added two flows to `tests/e2e/atrium-meridian-creation.spec.ts` (in their own
`describe` block) that each drive the primary action to a real outcome and verify the
persisted artifact independently of the UI:
- "Start blank" → loaded editor with a v1, verified by `GET /api/v1/content/:id` and
  asserting `bodyInline` contains the expected `<style>` marker (proves the body round-
  tripped through encode/decode intact, not just that *a* row exists).
- "Build it for me" → navigation to `/nexus?workspace=<id>` with the composer prefilled.

## Prevention

- For any create/save flow, an E2E spec that stops at "the dialog opened" or "the
  button was clicked" is not coverage of the write path — assert the terminal state
  (navigation, loaded editor) AND read the created object back over the REST API to
  prove the persisted shape.
- When a flow can be seeded directly over REST for speed in *other* specs, make sure at
  least one spec still drives the actual UI action end-to-end — REST-seeded specs can't
  catch a broken client-side write.
