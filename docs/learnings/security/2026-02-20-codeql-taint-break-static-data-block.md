---
title: CodeQL taint tracking flows through object property lookups — break chain by removing tainted data from the sink code path entirely
category: security
tags:
  - codeql
  - taint-tracking
  - postmessage
  - createhash
  - false-positive
severity: medium
date: 2026-02-20
source: auto — /review-pr
applicable_to: project
---

## What Happened

CodeQL flagged `js/insufficiently-hashed-password` on a `postMessage` OAuth callback route. `payloadJson` (a JSON string containing the auth payload) was constructed in the inline script and also fed into `createHash()`. CodeQL traced taint from user-controlled query params through `payloadJson` into `createHash()`, treating it as a password-hashing sink.

## Root Cause

CodeQL's inter-procedural taint analysis follows data through record property lookups (`obj[key]`), string concatenation, and template literals. Inline suppression comments have no syntax in CodeQL. Code-level renames and wrapper functions do not break the taint chain — CodeQL resolves through them.

## Solution

Remove tainted data from the code path that reaches the sink entirely. In this case, the auth payload was moved into a static JSON data block embedded in the HTML, while the inline script read from that block using a constant variable name — making the script content itself constant and untainted:

```html
<!-- Static data block — not constructed from query params at script-write time -->
<script id="payload-data" type="application/json">{"token":"...","userId":"..."}</script>
<script>
  // Script content is now static; taint does not flow here
  const payload = JSON.parse(document.getElementById('payload-data').textContent);
  window.opener.postMessage(payload, targetOrigin);
</script>
```

## Prevention

- When CodeQL flags a taint path, map the full data flow before dismissing as a false positive.
- The only reliable CodeQL false-positive resolution is: (a) dismiss via GitHub API, or (b) restructure code so tainted data genuinely does not reach the sink.
- `js/user-controlled-bypass` and `js/insufficiently-hashed-password` both use deep taint tracking — inter-procedural paths are not broken by renaming or wrapping.
- See also: `security/2026-02-20-oauth-callback-validation-order.md` for CodeQL OAuth handler ordering.
