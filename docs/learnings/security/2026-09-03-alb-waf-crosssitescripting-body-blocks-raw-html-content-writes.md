---
title: ALB WAF CrossSiteScripting_BODY silently 403s any write body containing raw <style>/<script>
category: security
tags:
  - waf
  - alb
  - aws-managed-rules
  - xss
  - base64
  - content-encoding
  - server-actions
  - silent-failure
  - atrium
severity: high
date: 2026-09-03
source: auto — /lfg
applicable_to: project
---

## What Happened

Issue #1714: creating an artifact from the Atrium library ("New page" → "Build it for
me" / "Start blank") never reached the app on any deployed environment. The server
action's POST body carried `ARTIFACT_STARTER_HTML` raw, which contains a `<style>`
block. The ALB WAF's `CrossSiteScripting_BODY` rule (part of
`AWSManagedRulesCommonRuleSet`; only `SizeRestrictions_BODY` and `GenericRFI_BODY` are
excluded in `infra/lib/frontend-stack-ecs.ts`) returned a bare 403 with a CloudFront
HTML body — no app log line, no content row created. Broken since the starter-body
seeding landed (#1639 era); the #1710 E2E suite passed because the local Playwright
harness sits in front of no WAF, so it never exercised this path.

## Root Cause

Any in-app write surface whose request body can contain `<script>`, `<style>`, or
inline `style=`/`onerror=` markup will trip `CrossSiteScripting_BODY` at the ALB, which
never reaches the Next.js app — so there is nothing to log, catch, or reproduce
locally. The codebase already has a transit-encoding convention for exactly this
(`codeEncoding` + `decodeContentBody`, used by `createVersionAction`), but the second
write surface (`createContentAction`, invoked from the Atrium library "New page" flow)
shipped raw because the browser-side encoder (`toBase64Utf8`) was a **private function
inside `ArtifactCanvas.tsx`**, so the new call site had no importable helper to reuse.

## Solution

- Extracted the encode half into `lib/content/code-encoding-browser.ts` (Web APIs only,
  no `Buffer` — must run in the browser).
- `createContentAction` now takes `opts: { codeEncoding }` and decodes via the shared
  `decodeContentBody` before `contentService.create`, mirroring `createVersionAction`.
- `LibraryView` sends the starter body base64-encoded via a shared
  `starterArtifactArgs(title, collectionId)` helper typed as
  `Parameters<typeof createContentAction>`, so both call sites stay in sync with the
  action's signature.
- Collapsed the WAF rationale (previously restated near-verbatim in ~8 places) into one
  canonical doc comment in `lib/content/code-encoding.ts` with pointers.

## Prevention

- Any write surface that can carry `<script>`/`<style>`/inline `style=` markup in a
  request body MUST use the transit encoding (`codeEncoding` + `decodeContentBody`) —
  never post the raw body.
- When adding a new content-write call site, grep for every other caller of the encode
  helper (`toBase64Utf8` / `code-encoding-browser.ts`) and confirm the new one is in
  that set before shipping.
- Never leave a browser-side encode helper as a private function inside one component —
  it becomes unreusable by design, which is exactly how the second write surface
  regressed. Put shared encode/decode helpers in `lib/content/`.
- A WAF 403 is invisible to app logs and to the local E2E harness (no WAF in front of
  it); if a write silently never lands with no server-side trace, check the ALB WAF
  managed-rule exclusions in `infra/lib/frontend-stack-ecs.ts` before assuming an app
  bug.
