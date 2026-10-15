---
title: A file-repairing CLI needs an atomic write and must honor its own documented exit codes
category: workflow
tags:
  - psd-rules
  - literal-newline-repair
  - atomic-write
  - os.replace
  - exit-codes
  - code-review-triage
severity: medium
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1896 / PR #1930: `repair_literal_newlines.py` used `open(path, "w")`, which truncates the file before the new bytes land. The tool runs inside an agent turn with a deadline, so a mid-write kill left a half-file with the original content already gone. Separately, the CLI had a documented 0/0/2 exit-code contract, but a missing file, a non-UTF-8 file, and an unwritable directory each raised an uncaught exception and exited 1 with a traceback instead.

## Root Cause

Truncate-then-write has no recovery path if the process dies between the two steps. A documented exit-code contract only holds if every error path is caught and mapped to it — an unhandled exception on an edge-case input exits however Python exits, not however the contract promises.

## Solution

- Write to a temp file in the same directory, `fsync`, `shutil.copymode` from the original, then `os.replace` onto the `realpath` (so a symlink gets replaced-through, not replaced-over) — the original is never truncated before the replacement is ready.
- Catch the specific exceptions for missing file / decode failure / permission error and map each to the documented exit code instead of letting them propagate as an uncaught traceback.

## Prevention

- Any script that rewrites a file in place and can be killed mid-run needs temp-file-plus-`os.replace`, not `open(path, "w")`.
- If a CLI documents an exit-code contract, enumerate the realistic failure inputs (missing file, bad encoding, no write permission) and verify each one actually produces the documented code — don't assume the happy-path handler covers them.
- Six parallel reviewers were dispatched on this PR; the concrete, reproducible corruption findings came from the adversarial reviewer, and each was confirmed by reproducing it on a real file rather than trusting the report. Reviewers without a Bash tool reported static-trace claims that still needed independent verification before acting on them.
