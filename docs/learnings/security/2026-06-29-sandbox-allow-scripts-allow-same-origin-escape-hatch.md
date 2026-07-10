---
title: Granting allow-scripts AND allow-same-origin together lets framed code escape its own sandbox
category: security
tags:
  - iframe
  - sandbox
  - allow-scripts
  - allow-same-origin
  - opaque-origin
  - CSP
severity: critical
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 2 sandbox iframe uses `sandbox="allow-scripts"` without `allow-same-origin`. This is intentional — the combination is the documented escape hatch that lets script inside the iframe remove the `sandbox` attribute from its own parent `<iframe>` element, completely lifting all sandbox restrictions.

## Root Cause

Per the HTML spec: a sandboxed iframe with both `allow-scripts` and `allow-same-origin` can use `parent.document.querySelector('iframe').removeAttribute('sandbox')` to remove its own sandbox. The iframe has same-origin access to the parent document (because `allow-same-origin` grants it the serving origin), so the script can mutate the DOM of the page that frames it.

Without `allow-same-origin`, the iframe runs under an opaque origin. It cannot access the sandbox host's cookies, localStorage, or parent document — isolation is intact.

## Solution

Use exactly `sandbox="allow-scripts"` for HTML artifact rendering. Never add `allow-same-origin` unless the framed content is fully trusted first-party code (not user/AI-generated artifacts).

## Prevention

Treat the combination `allow-scripts allow-same-origin` as a red flag in code review for any iframe rendering untrusted content. The MDN security note is explicit: granting both together makes the sandbox "as if no sandbox attribute was set at all."
