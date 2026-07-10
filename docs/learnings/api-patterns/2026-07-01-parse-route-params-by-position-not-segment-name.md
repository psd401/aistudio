---
title: Parse dynamic route params from real Next.js params, not by URL segment name
category: api-patterns
tags:
  - nextjs
  - route-params
  - withApiAuth
  - extractStringParam
  - slug-collision
  - atrium
severity: medium
date: 2026-07-01
source: auto — /lfg #1090
applicable_to: project
---

## What Happened

`lib/api/route-helpers.ts` `extractStringParam(url, segmentName)` locates a path
segment by `indexOf(segmentName)` and returns the **next** segment. That misparses
whenever a dynamic value equals a path literal. Concretely, for the route
`/api/v1/content/[id]/publish/[destination]`, a content slug of `"publish"` makes
`DELETE /api/v1/content/publish/publish/schoology` →
`extractStringParam(url, "publish")` return the `"publish"` **path literal** as the
destination → "Invalid destination" 400 → the object is un-unpublishable. The
`[id]` routes have the same class if a slug equals `"content"`.

## The Rule

In App Router route handlers, read dynamic params from the **real Next.js route
params**, never by parsing the URL by segment name. Next passes the route context
as the handler's second argument; `context.params` is a `Promise` (Next 15+) that
resolves to the matched `{ [param]: value }`.

## The Fix

`withApiAuth` (the auth/rate-limit HOC) previously dropped the route context. It
now accepts `(request, context?)`, awaits `context.params`, and passes the resolved
object as a **4th** handler argument (backward compatible — the ~16 non-dynamic
handlers ignore it and receive `{}`). Atrium content routes now read `params.id` /
`params.destination` directly. Type the resolved params as
`Record<string, string | undefined>` (not `Record<string, string>`) so a handler
must null-check a key that isn't a real segment; the routes already guard
`if (!id) return 400`.

Left the ~5 non-Atrium routes still using `extractStringParam` untouched (out of
scope) — they can adopt real params in a follow-up.
