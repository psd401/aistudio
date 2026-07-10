---
title: A fix for a bug whose root cause lives in code you can't inspect should be worded as "mitigates the leading hypothesis," not "fixes X"
category: workflow
tags:
  - external-dependency
  - root-cause-confidence
  - pr-framing
  - issue-closing
  - lfg
severity: medium
date: 2026-07-05
source: auto — /lfg (issue #1106, PR #1109)
applicable_to: project
---

## What Happened

Issue #1106 (FS#162394) was triaged with only MEDIUM-LOW confidence: the
suspected root cause (an external Lambda, `psd-data-mcp`, not in this repo,
rejecting SQL casts to NUMERIC/DECIMAL without explicit precision) could not
be confirmed because the Lambda's source wasn't inspectable. The initial fix
implementation's code comments and PR framing nonetheless used language like
"the confirmed trigger" for what was still an unconfirmed hypothesis.
Adversarial review flagged this — shipping with overclaiming language risks a
human reviewer or a future agent treating the underlying issue as fully
understood and closed when it isn't.

## Root Cause

It's tempting to write confident-sounding comments/PR descriptions once a fix
is implemented, even when the fix only mitigates a *hypothesis* rather than a
confirmed mechanism. The confidence level assigned during triage doesn't
automatically carry forward into the language used once code is written.

## Solution

Reworded comments and PR description to say the client-side check "mitigates
the leading hypothesis" rather than "fixes X" or "the confirmed trigger."

## Prevention

- When a fix addresses a bug whose root cause lives in code/infra you don't
  own or can't inspect (an external Lambda, a third-party service, a vendored
  binary), word the fix in comments and PR text as mitigating the *leading
  hypothesis*, not as fixing a confirmed mechanism — unless you've actually
  confirmed it (e.g., by reproducing against the real dependency).
- Don't auto-close the originating issue via a `Closes #N` / `Fixes #N` PR
  keyword when the actual mechanism remains unconfirmed. Reference the issue
  (`Related to #N`, `Mitigates #N`) without closing it, so the issue stays
  open for confirmation or a follow-up if the hypothesis turns out to be
  wrong.
- Carry the triage's confidence rating (e.g., MEDIUM-LOW) forward into the
  PR description explicitly, rather than letting it silently upgrade to
  "confirmed" once code exists.
