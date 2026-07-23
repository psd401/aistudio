---
title: A reader footer that aggregates over ALL versions leaks post-publication draft activity to the public
category: security
tags:
  - information-disclosure
  - public-surface
  - aggregate-query
  - provenance
  - atrium
severity: medium
date: 2026-07-05
source: auto — /lfg #1057 (PR #1110 review, chatgpt-codex P2)
applicable_to: project
---

## What Happened

`ProvenanceFooter` summarized an object's authorship with `MAX(version_number)` +
`BOOL_OR(author_actor = 'agent'/'human')` scoped only by `WHERE object_id = $1` —
the WHOLE version history. That was fine while it only rendered on the internal,
session-gated `/c/[slug]` reader. Phase 7 (#1057) reused the SAME component on the
NEW anonymous `/p/[slug]` public reader, which serves one specific *published*
version.

Because the aggregate spanned all versions, a draft `v3` created after the published
`v2` leaked to anonymous visitors: the footer showed "Last updated v3" and an
"AI-drafted" badge for the unpublished draft — revealing private editing activity on
a public URL. No content leaked (the body still renders the published version), but
the metadata did.

## The Fix

Bound the aggregate to the version being rendered. The reader routes already hold
the published version's number, so pass it (a plain number — no id→number subquery)
and add `version_number <= n`:

```ts
const versionBound = publishedVersionNumber !== undefined
  ? lte(contentVersions.versionNumber, publishedVersionNumber)
  : undefined;
// ...where(and(eq(contentVersions.objectId, objectId), versionBound))
```

Both readers now pass it, so the footer describes the version being read, not future
drafts. Verified by DB probe: with an agent-authored draft `v2` present, `/p` shows
only `v1` + "Human-reviewed", no "AI-drafted".

## The General Lesson

When a component that computes an AGGREGATE over a whole entity's history is reused
on a public/anonymous surface, the aggregate becomes an information-disclosure sink:
`MAX`/`BOOL_OR`/`COUNT` over rows the public shouldn't know exist still leak *that
they exist* even when the row bodies are gated. Scope any reused summary to exactly
the subset the surface is authorized to reveal (here: versions up to the published
one). Reusing an internal component on a public route is not free — re-audit every
query it runs against the public threat model, not just the render output.
