---
title: WebP magic-byte validation requires secondary RIFF marker check at bytes 8-11
category: security
tags:
  - magic-bytes
  - file-upload
  - webp
  - validation
  - s3
  - server-actions
severity: high
date: 2026-03-09
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #827 (branding settings) added server-side file type validation for logo uploads. The initial check validated only bytes 0-3 for the RIFF signature (`52 49 46 46`). This is insufficient: WAV and AVI files share the same RIFF container header. A malicious actor could upload a WAV file that passes validation as a WebP.

## Root Cause

WebP is a RIFF container format — it begins with the generic RIFF header, not a unique WebP-specific signature. Checking only `bytes[0..3] === "RIFF"` is a single-container-format pitfall that incorrectly trusts a shared header as proof of image type.

## Solution

Add a secondary check at bytes 8-11 for the `WEBP` marker:

```typescript
const riff = header.slice(0, 4).toString("ascii") === "RIFF";
const webp = header.slice(8, 12).toString("ascii") === "WEBP";
if (!riff || !webp) throw new Error("Invalid WebP file");
```

Both checks are required together to confirm a WebP file.

## Prevention

- Any RIFF-container format (WebP, WAV, AVI, WEBM) requires a secondary chunk-type check beyond the leading RIFF signature.
- When adding magic-byte validation, consult the format spec for the secondary identifier, not just the container signature.
- Apply the same two-check pattern to other container-wrapped formats (e.g., MP4/QuickTime share `ftyp` at byte 4 — still verify the brand at bytes 8-11).
