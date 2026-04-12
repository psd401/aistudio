---
title: "@google/genai SDK Blob is not the Web API Blob"
category: api-patterns
tags:
  - google-genai
  - gemini-live
  - websocket
  - voice
  - sdk-types
severity: high
date: 2026-04-08
source: auto — /work
applicable_to: project
---

## What Happened

Implementing Gemini Live voice integration via `@google/genai`. Passing a web API `Blob` to `sendRealtimeInput({ audio: blob })` caused silent failures — the SDK parameter is named `audio` and typed as `Blob`, but it expects the SDK's own `Blob` type, not the browser/Node.js `Blob`.

## Root Cause

`@google/genai` defines its own `Blob` interface: `{ data: string, mimeType: string }` where `data` is a base64-encoded string. It shares the name with the web API `Blob` but is structurally incompatible. TypeScript does not catch this if the web `Blob` satisfies the structural check.

## Solution

Convert audio data to base64 before passing to `sendRealtimeInput`:

```typescript
// Wrong — web API Blob
await session.sendRealtimeInput({ audio: webBlob });

// Correct — SDK Blob type
const arrayBuffer = await webBlob.arrayBuffer();
const base64 = Buffer.from(arrayBuffer).toString("base64");
await session.sendRealtimeInput({
  audio: { data: base64, mimeType: "audio/pcm;rate=16000" }
});
```

## Prevention

When using `@google/genai`, treat any parameter typed as `Blob` as the SDK's custom type. Do not import or pass the global `Blob`. Check the `@google/genai` type definitions directly (`node_modules/@google/genai/types.d.ts`) to confirm the shape before passing audio data.
