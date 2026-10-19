---
title: a download route that names the file from the object basename must not share that basename with a disambiguator — give the request id its own key segment
category: integration
tags:
  - s3
  - content-disposition
  - document-generation
  - nexus
severity: medium
date: 2026-10-19
source: auto — issue #1898, PR #1941 (Codex review round 5)
applicable_to: project
---

## What Happened

The download card advertised `staff-newsletter.docx` (its `download`
attribute and visible label), but the browser saved
`V1StGXR8_Z-staff-newsletter.docx`. The route set
`Content-Disposition: attachment; filename="<basename>"` from the S3 key, and
the key was `…/{conversationId}/{requestId}-{filename}` — the request id that
disambiguates concurrent generations had been prepended to the basename.

## Root Cause

Two reasonable decisions collided. The route derives everything it serves from
the validated key (no DB row to consult, no writer-controlled metadata
trusted), so the filename *is* the basename. The generator, mirroring the
image service, folded its request id into that basename. A `Content-
Disposition` filename wins over an anchor's `download` attribute, so the card's
value never applied. The E2E only checked the extension, so it passed.
Stripping the id in the route was not an option either: `generateRequestId`
is `nanoid(10)`, whose alphabet includes `-`, so "cut at the first hyphen" is
wrong on roughly one id in seven.

## Solution

The request id is now its own path segment:
`v2/nexus-documents/{conversationId}/{requestId}/{filename}`. The basename is
exactly the advertised filename, the route is unchanged apart from comments,
`isConversationScopedDocumentKey` validates three segments (UUID, `[\w-]`
request segment — so `.`/`..` can never match — and `[\w-]+.ext`), and the
legacy prefixed form is rejected. The E2E now asserts
`download.suggestedFilename()` equals the card's `data-filename`.

## Prevention

When a route serves a file under a name derived from its storage key, any
disambiguator (request id, timestamp, hash) belongs in its own segment, never
in the basename. Pin the user-facing name in the route's unit test with the
exact `Content-Disposition` string and, in the E2E, compare the browser's
suggested filename with what the UI advertised — an `endsWith(".docx")` check
cannot catch a prefix.
