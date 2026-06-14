---
title: Data URL media type extraction requires CRLF exclusion and MIME allowlist to prevent injection
category: security
tags:
  - data-url
  - media-type
  - mime-type
  - header-injection
  - log-injection
  - allowlist
  - image-upload
severity: high
date: 2026-05-28
source: auto — /work
applicable_to: project
---

## What Happened

When correcting the hardcoded `mediaType:"image/png"` set by `toCreateMessage`
(see ai-sdk/2026-05-28 learning), the server extracts the real MIME type from the
data URL prefix (e.g. `data:image/jpeg;base64,...`). Without sanitizing the
extracted string, a crafted data URL such as `data:image/jpeg\r\nX-Injected:
evil;base64,...` could inject arbitrary text into server logs or HTTP headers that
include the media type.

## Root Cause

A naive regex like `/^data:([^;]+);/` captures everything up to the first `;`,
including `\r` and `\n`. If the extracted string is written to a log field or
forwarded as a Content-Type header, newline characters produce log/header injection.

## Solution

Exclude `;`, `,`, `\r`, and `\n` from the capture group, and validate the result
against an explicit allowlist of known-good MIME types before use:

```typescript
// Exclude ;,\r\n from the captured segment to prevent header/log injection
const match = /^data:([^;,\r\n]+)[;,]/.exec(url);
if (!match) return null;
const mediaType = match[1].toLowerCase().trim();

const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp', 'image/tiff',
]);

return ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType) ? mediaType : null;
```

Returning `null` for any type not in the allowlist means only known-safe types
reach provider API requests or log statements.

## Prevention

- Any server-side extraction of a value embedded in user-controlled data (data
  URLs, multipart boundaries, etc.) must exclude `\r` and `\n` from the capture
  group.
- Pair CRLF exclusion with a MIME type allowlist. Structural exclusion prevents
  injection; the allowlist prevents unknown types from being forwarded.
- See `lib/services/attachment-storage-service.ts` for the canonical
  `extractDataUrlMediaType` implementation used in this project.
- Apply the same pattern wherever file metadata (content type, filename) is
  read from user-supplied data and later included in headers or logs.
