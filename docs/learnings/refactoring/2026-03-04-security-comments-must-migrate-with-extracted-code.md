---
title: Security and doc comments must migrate with extracted code to shared utilities
category: refactoring
tags:
  - extraction
  - shared-utilities
  - security-comments
  - documentation-migration
severity: high
date: 2026-03-04
source: auto — /review-pr
applicable_to: project
---

## What Happened

During PR #822 review (argsText error boundary fix), a constant and a utility function were extracted from an inline component into a shared module. The original file contained a safety warning about SVG injection risk in plot data validation (`isSafePlotData`). That comment was dropped during the extraction — leaving the shared utility with no indication of the security assumption it encodes (self-reported MIME type, no binary inspection).

A second issue: the constant `MAX_RECOVERY_ATTEMPTS` was misleading because `getDerivedStateFromError` (which has no access to current state) resets it on error, causing the effective cap to be threshold+1 due to async setState stale-state reads. Renamed to `RECOVERY_ATTEMPT_THRESHOLD` to reflect actual behavior.

## Root Cause

Refactoring focus is on code structure, not comment preservation. Safety/doc comments in source files are not automatically flagged as "must migrate" during extraction — they are silently left behind.

## Solution

- Audited original file after extraction; carried the SVG injection warning forward into the shared utility's JSDoc
- Renamed `MAX_RECOVERY_ATTEMPTS` → `RECOVERY_ATTEMPT_THRESHOLD` to match effective semantics
- Added 12 edge-case unit tests for `isSafePlotData` covering null, malformed, unexpected MIME types, and boundary values

## Prevention

- After any extraction to a shared utility, re-read the original source for security comments, `// SAFETY:`, `// IMPORTANT:`, or `// NOTE:` annotations and carry them forward
- When naming a constant that controls a threshold (not a hard limit), prefer `*_THRESHOLD` over `*_MAX` or `*_LIMIT` if the actual cap is derived (e.g., +1 from framework behavior)
- Treat security utility functions as requiring unit tests at extraction time, not as a follow-up
