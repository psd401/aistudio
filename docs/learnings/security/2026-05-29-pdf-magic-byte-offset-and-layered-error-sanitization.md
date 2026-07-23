---
title: "PDF spec allows %PDF header anywhere in first 1,024 bytes — plus two-layer error sanitization for async Lambda pipelines"
category: security
tags:
  - magic-bytes
  - file-upload
  - pdf
  - validation
  - lambda
  - error-sanitization
  - sentinel-propagation
  - job-pipeline
severity: medium
date: 2026-05-29
source: auto — /lfg issue-994
applicable_to: project
---

## What Happened

Issue #994: PDFs that upload successfully in Claude.ai and ChatGPT were rejected by AI Studio Nexus with a silent failure. Scanned PDFs additionally produced an opaque "Server processing failed" error with no actionable detail.

Three bugs were found and fixed in PR #1006:

1. **Client-side magic-byte check assumed `%PDF` at byte 0.** Byte 0 is the common case, but the PDF spec (ISO 32000-1:2008 §7.5.2) requires only that the header appear *within the first 1,024 bytes*. PDFs with a leading BOM, embedded metadata preamble, or other non-standard prefixes fail this check even though they are valid files accepted by every major PDF consumer.

2. **Server-side `FileTypeDetector` had the identical byte-0 constraint.** Both layers independently assumed offset 0, so even if the client check was bypassed, the server rejected the same files.

3. **Scanned PDFs surfaced a raw Lambda sentinel string to the API caller.** The sentinel message used internally to signal a processing failure was returned verbatim in the job status API response body, leaking internal implementation detail to any authenticated user.

## Root Cause

### Bug 1 & 2 — Magic byte byte-0 assumption

A naive implementation of PDF validation checks `buffer.slice(0, 4).toString() === "%PDF"`. This is fast and correct for the majority of PDFs, but incorrect for the full spec. Unlike PNG (always `\x89PNG` at byte 0) or JPEG (`\xFF\xD8\xFF` at byte 0), PDF intentionally permits a variable-length preamble, giving tools room to embed metadata or encoding marks before the file header.

The mismatch with Claude.ai and ChatGPT was the direct cause of user confusion: those services either don't check, or check correctly, so a file that works there is rejected here.

### Bug 3 — Sentinel leakage

The async Lambda job pipeline uses a sentinel string (e.g., `PROCESSING_FAILED: <reason>`) to communicate failure type back through the job status table. The API route read the sentinel from the DB and returned it directly in the HTTP response without sanitization. Any authenticated user polling job status could read the raw sentinel string, revealing internal error structure.

## Solution

### Fix 1 & 2 — Scan first 1,024 bytes

Replace byte-0 equality checks with a window scan:

```typescript
// Client-side (browser ArrayBuffer)
function findByteSequence(buffer: Uint8Array, needle: number[]): number {
  const limit = Math.min(buffer.length, 1024) - needle.length + 1;
  outer: for (let i = 0; i < limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buffer[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const isPdf = findByteSequence(bytes, PDF_MAGIC) !== -1;
```

```typescript
// Server-side (Node.js Buffer)
const PDF_MAGIC = Buffer.from("%PDF");
const isPdf = buffer.indexOf(PDF_MAGIC, 0) < 1024;
```

Apply this fix symmetrically to both layers. Both must agree on what constitutes a valid PDF or whichever is more permissive will be the effective gate.

### Fix 3 — Two-layer error sanitization

**Layer 1 — Client (SAFE_ERROR_MAP):** Map sentinel prefixes to user-friendly strings before displaying anything:

```typescript
const SAFE_ERROR_MAP: Record<string, string> = {
  PROCESSING_FAILED: "The file could not be processed. Try a different file.",
  UNSUPPORTED_FORMAT: "This file format is not supported.",
  // ...
};

function safeClientError(raw: string): string {
  for (const [prefix, message] of Object.entries(SAFE_ERROR_MAP)) {
    if (raw.startsWith(prefix)) return message;
  }
  return "An error occurred. Please try again.";
}
```

**Layer 2 — Server (sanitizeJobError):** Never pass the raw sentinel to the HTTP response. The API route strips internal structure before serialising:

```typescript
function sanitizeJobError(raw: string | null): string | null {
  if (!raw) return null;
  for (const [prefix, message] of Object.entries(SAFE_ERROR_MAP)) {
    if (raw.startsWith(prefix)) return message;
  }
  return "Processing failed.";
}

// In the API route handler:
return NextResponse.json({
  status: job.status,
  error: sanitizeJobError(job.error),
});
```

The client layer provides UX polish; the server layer is the security boundary. Both are required.

## Sentinel propagation pattern for async Lambda pipelines

When a Lambda processes a job asynchronously and writes a result to a database table, failures need to convey *type* (not just presence) so that different errors can produce different UX. The pattern:

1. **Define a fixed set of sentinel prefixes** (e.g., `PROCESSING_FAILED`, `UNSUPPORTED_FORMAT`). Keep them in a shared constants file imported by both the Lambda and the API route.
2. **Lambda writes `SENTINEL_PREFIX: <internal detail>`** to the job error column. The detail may include raw exception text — that's fine because it never leaves the DB.
3. **API route reads, sanitizes, returns.** `sanitizeJobError()` strips everything after the prefix and maps to a safe string. Internal detail is logged server-side but not forwarded.
4. **Client maps prefix to UX string.** `SAFE_ERROR_MAP` is the single source of truth for user-facing copy. Client-side mapping is redundant with the server sanitization but ensures no raw string reaches the DOM even if the server sanitization has a gap.

## Prevention

- When adding magic-byte validation for any format, read the spec section on file structure to determine whether the magic marker is guaranteed at byte 0 or may be offset. Assume byte 0 only for formats that explicitly require it (PNG, JPEG, GIF).
- Apply magic-byte validation symmetrically: if both client and server check, both must use the same (correct) window.
- Never return a job error column value directly in an API response. Always pass through `sanitizeJobError()` or equivalent before serializing.
- Treat sentinel strings as internal-only. Define them in a constants file, reference that file in both producer (Lambda) and consumer (API), and keep the SAFE_ERROR_MAP in the same file so additions stay in sync.
