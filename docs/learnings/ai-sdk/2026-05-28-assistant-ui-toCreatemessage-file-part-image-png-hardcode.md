---
title: assistant-ui toCreateMessage wraps image attachments as type:"file" with url and hardcodes mediaType:"image/png"
category: ai-sdk
tags:
  - assistant-ui
  - toCreateMessage
  - file-parts
  - image-upload
  - mediaType
  - nexus
severity: high
date: 2026-05-28
source: auto — /work
applicable_to: project
---

## What Happened

JPEG uploads in Nexus chat crashed with a `TypeError` on `.id`. The AI SDK's stream
parser received a non-stream body because the message save to the database had
silently failed. The save failed because `processMessagePart` in `chat-helpers.ts`
had no handler for `type:"file"` parts, so every message with an image attachment
produced `parts: []` in the DB insert — then the follow-up `processMessagesWithAttachments`
call to the route could not find the conversation, causing a 5xx that the SDK tried
to parse as an SSE stream.

## Root Cause

`@assistant-ui/react-ai-sdk`'s `toCreateMessage` converts image attachments to
**`type:"file"` parts** (not `type:"image"`). The part has a `url` property (not
`image` or `data`) containing the base64 data URL, and it hardcodes
`mediaType:"image/png"` regardless of the uploaded file's actual MIME type.

The AI SDK's `convertToModelMessages` maps `part.url → data` for file parts
internally (ai/dist/index.js ~line 9572), so these parts do reach the AI provider
correctly — but any server-side code that only handles `type:"text"` and
`type:"image"` will silently skip them.

Additionally, because `mediaType` is always `"image/png"`, JPEG images sent to
providers that care about MIME type (e.g. Claude via Bedrock) may be processed
with incorrect framing. The fix is to extract the actual media type from the
data URL prefix.

## Solution

In `processMessagePart` (and any equivalent server-side part handler), add a
`type:"file"` case that detects image parts by checking `mediaType` or the data URL
prefix:

```typescript
if (typedPart.type === 'file') {
  const mediaType = typedPart.mediaType as string | undefined;
  const url = typedPart.url as string | undefined;
  if (
    (typeof mediaType === 'string' && mediaType.startsWith('image/')) ||
    (typeof url === 'string' && url.startsWith('data:image/'))
  ) {
    return { content: '', serialized: { type: 'image', metadata: { hasImage: true } } };
  }
}
```

To correct the media type before forwarding to the AI provider, extract it from
the data URL and validate against an allowlist (see security note below):

```typescript
// In processMessagesWithAttachments
if (partData.type === 'file' && typeof partData.url === 'string' && partData.url.startsWith('data:')) {
  const actualMediaType = extractDataUrlMediaType(partData.url);
  lightweightParts.push({ ...part, mediaType: actualMediaType ?? part.mediaType });
}
```

## Prevention

- Never assume `type:"image"` is the only format for image parts when using
  `@assistant-ui/react-ai-sdk`. Always handle `type:"file"` parts with image
  `mediaType` or `data:image/` URL prefixes.
- When adding a new part type to `processMessagePart`, also update
  `processMessagesWithAttachments` in `attachment-storage-service.ts` (both paths
  must stay in sync).
- `mediaType:"image/png"` from `toCreateMessage` is a hardcoded default — always
  prefer the type extracted from the data URL itself.
- See `lib/services/attachment-storage-service.ts` for the `extractDataUrlMediaType`
  helper and `ALLOWED_IMAGE_MEDIA_TYPES` allowlist.
