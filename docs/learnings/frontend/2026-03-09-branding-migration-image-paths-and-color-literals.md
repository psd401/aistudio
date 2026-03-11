---
title: Branding migration must audit image paths and color literals, not just text strings
category: frontend
tags:
  - branding
  - accessibility
  - review-patterns
severity: medium
date: 2026-03-09
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #828 replaced hardcoded branding with settings-driven values. Initial implementation
missed `/psd-ai-logo.png` (a district-specific image path) and `bg-sky-600` / `sky-600`
color literals on the landing page. These were not near the text-string branding changes
so they were not caught in the first pass.

## Root Cause

Branding is mentally modeled as text (names, titles, taglines). Image `src` attributes
and Tailwind color classes don't read as "branding" during implementation, so they survive
initial replacement sweeps.

## Solution

Add explicit grep passes during branding migration:
```bash
# Image paths
rg "/psd-|/district-|/logo\." --type tsx --type ts

# Hardcoded color classes tied to brand palette
rg "sky-600|brand-blue|#005" --type tsx
```

Replace with dynamic values from the branding config (`logoUrl`, `primaryColor`).

## Prevention

- Before opening a branding PR, run the above greps and resolve all hits
- Treat image `src` strings and palette-specific Tailwind classes as branding references
- Also audit `alt=""` on logo `<img>` tags — empty alt on a meaningful image is a WCAG violation;
  use the brand name as alt text (e.g., `alt={branding.organizationName}`)
