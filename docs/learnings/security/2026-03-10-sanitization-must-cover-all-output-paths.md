---
title: Sanitization must cover all output paths — missing one creates a false sense of security
category: security
tags:
  - sanitization
  - consistency
  - xss
  - branding
severity: high
date: 2026-03-10
source: auto — /review-pr
applicable_to: project
---

## What Happened

A PR sanitized operator-provided branding values in the HTML and plain-text output paths of an attachment generator, but left the markdown output path (`generateMarkdownAttachment()`) unsanitized. A reviewer caught this in Round 1 of PR #829.

## Root Cause

When adding sanitization incrementally across multiple output formats (HTML, text, markdown), it is easy to treat the first two as "done" and overlook the third. The omission was not caught before review because each path looked correct in isolation.

## Solution

Apply the same sanitization call to every output path that renders operator- or user-controlled values. In this case, the same `sanitizeBrandingValue()` call used in the HTML and text paths was added to `generateMarkdownAttachment()`.

## Prevention

- When a function has N output paths, treat sanitization as an N-of-N requirement, not a per-path checkbox.
- During PR self-review, grep for the sanitization function name and count call sites against the number of output paths.
- Sanitize at the point of value capture (top of function, once) rather than at each render site to eliminate per-path omission risk.
