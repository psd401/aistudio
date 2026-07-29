import type { UIMessage } from "ai";
import { runRequiredSecurityScan } from "@/lib/security/required-security-scan";
import { ContentSafetyBlockedError } from "@/lib/streaming/types";
import type { ContentSafetyResult } from "@/lib/safety/content-safety-service";
import type { TokenMapping } from "@/lib/safety/types";

export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MAX_INLINE_ATTACHMENT_NAME_LENGTH = 255;
const MAX_INLINE_ATTACHMENT_MEDIA_TYPE_LENGTH = 255;

interface MessageLike {
  role?: string;
  parts?: unknown[];
  content?: unknown;
}

interface InlineAttachmentSafetyProcessor {
  isEnabled(): boolean;
  isPiiTokenizationEnabled(): boolean;
  processInput(content: string, sessionId: string): Promise<ContentSafetyResult>;
}

interface CanonicalizationResult<T extends MessageLike> {
  messages: T[];
  inlineAttachmentCount: number;
  totalBytes: number;
}

export interface InlineAttachmentSafetyResult {
  messages: UIMessage[];
  processedValues: string[];
  tokens: TokenMapping[];
}

export class NexusInlineAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NexusInlineAttachmentValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalText(value: unknown): string {
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new NexusInlineAttachmentValidationError(
        "Inline attachment content must not be empty"
      );
    }
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachment content must be text or an array of text segments"
    );
  }
  const segments = value.map((segment) => {
    if (
      !isRecord(segment) ||
      segment.type !== "text" ||
      typeof segment.text !== "string" ||
      !segment.text.trim() ||
      Object.keys(segment).some((key) => key !== "type" && key !== "text")
    ) {
      throw new NexusInlineAttachmentValidationError(
        "Inline attachment segments must contain only non-empty text"
      );
    }
    return segment.text;
  });
  return segments.join("\n");
}

function validateOptionalMetadata(part: Record<string, unknown>): void {
  if (
    part.name !== undefined &&
    (typeof part.name !== "string" ||
      !part.name.trim() ||
      part.name.length > MAX_INLINE_ATTACHMENT_NAME_LENGTH)
  ) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachment name is invalid"
    );
  }
  for (const field of ["contentType", "mediaType"] as const) {
    const value = part[field];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !value.trim() ||
        value.length > MAX_INLINE_ATTACHMENT_MEDIA_TYPE_LENGTH)
    ) {
      throw new NexusInlineAttachmentValidationError(
        "Inline attachment media type is invalid"
      );
    }
  }
}

function isAttachmentPart(part: Record<string, unknown>): boolean {
  return part.type === "document" || part.type === "file";
}

function hasReferenceOnlyShape(part: Record<string, unknown>): boolean {
  return (
    typeof part.url === "string" ||
    typeof part.s3Key === "string" ||
    typeof part.attachmentId === "string"
  );
}

function normalizeMessageRepresentation<T extends MessageLike>(
  message: T
): T & { parts: unknown[] } {
  const record = message as Record<string, unknown>;
  const hasParts = hasOwn(record, "parts");
  const hasContent = hasOwn(record, "content");
  if (hasParts && hasContent) {
    throw new NexusInlineAttachmentValidationError(
      "Messages cannot contain both parts and legacy content"
    );
  }

  let parts: unknown[];
  if (hasParts) {
    if (!Array.isArray(message.parts)) {
      throw new NexusInlineAttachmentValidationError(
        "Message parts must be an array"
      );
    }
    parts = message.parts;
  } else if (hasContent) {
    if (typeof message.content === "string") {
      parts = [{ type: "text", text: message.content }];
    } else if (Array.isArray(message.content)) {
      parts = message.content;
    } else {
      throw new NexusInlineAttachmentValidationError(
        "Legacy message content must be text or an array of parts"
      );
    }
  } else {
    parts = [];
  }

  const normalized = { ...message, parts };
  delete normalized.content;
  return normalized;
}

/**
 * Return the one canonical inline value. `null` means this is a reference-only
 * file part. Ambiguous or malformed inline shapes throw.
 */
export function canonicalInlineAttachmentText(
  part: Record<string, unknown>
): string | null {
  if (!isAttachmentPart(part)) return null;
  const hasContent = hasOwn(part, "content");
  const hasData = hasOwn(part, "data");
  if (hasContent && hasData) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachments cannot contain both content and data"
    );
  }
  if (!hasContent && !hasData) {
    if (hasReferenceOnlyShape(part)) return null;
    throw new NexusInlineAttachmentValidationError(
      "Inline attachment content or a canonical reference is required"
    );
  }
  if (
    hasReferenceOnlyShape(part) ||
    hasOwn(part, "image")
  ) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachment content cannot be combined with another payload"
    );
  }
  validateOptionalMetadata(part);
  const text = canonicalText(hasContent ? part.content : part.data);
  if (Buffer.byteLength(text, "utf8") > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachment content exceeds the 25MB limit"
    );
  }
  return text;
}

function canonicalizePart(
  part: unknown,
  allowInline: boolean
): { part: unknown; bytes: number; inline: boolean } {
  if (!isRecord(part) || !isAttachmentPart(part)) {
    return { part, bytes: 0, inline: false };
  }
  const text = canonicalInlineAttachmentText(part);
  if (text === null) return { part, bytes: 0, inline: false };
  if (!allowInline) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachments are allowed only on the current user message"
    );
  }
  const canonicalPart: Record<string, unknown> = { ...part, data: text };
  delete canonicalPart.content;
  return {
    part: canonicalPart,
    bytes: Buffer.byteLength(text, "utf8"),
    inline: true,
  };
}

/**
 * Canonicalize inline document/file bodies once, before any turn side effect.
 * The returned messages contain only a single bounded `data` value for each
 * inline attachment.
 */
export function canonicalizeInlineAttachmentMessages<T extends MessageLike>(
  messages: readonly T[]
): CanonicalizationResult<T> {
  const normalizedMessages = messages.map(normalizeMessageRepresentation);
  const lastUserIndex = normalizedMessages.findLastIndex(
    (message) => message.role === "user"
  );
  let inlineAttachmentCount = 0;
  let totalBytes = 0;
  const canonicalMessages = normalizedMessages.map((message, messageIndex) => {
    const parts = message.parts.map((part) => {
      const canonical = canonicalizePart(
        part,
        messageIndex === lastUserIndex
      );
      if (canonical.inline) {
        inlineAttachmentCount += 1;
        totalBytes += canonical.bytes;
        if (totalBytes > MAX_INLINE_ATTACHMENT_BYTES) {
          throw new NexusInlineAttachmentValidationError(
            "Combined inline attachment content exceeds the 25MB limit"
          );
        }
      }
      return canonical.part;
    });
    return { ...message, parts };
  });
  return {
    messages: canonicalMessages as T[],
    inlineAttachmentCount,
    totalBytes,
  };
}

function inlineLocations(messages: UIMessage[]): Array<{
  messageIndex: number;
  partIndex: number;
  text: string;
}> {
  const locations: Array<{
    messageIndex: number;
    partIndex: number;
    text: string;
  }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.parts)) continue;
    for (const [partIndex, value] of message.parts.entries()) {
      if (!isRecord(value) || !isAttachmentPart(value)) continue;
      const text = canonicalInlineAttachmentText(value);
      if (text !== null) locations.push({ messageIndex, partIndex, text });
    }
  }
  return locations;
}

function replaceAtLocation(
  messages: UIMessage[],
  messageIndex: number,
  partIndex: number,
  data: string
): UIMessage[] {
  return messages.map((message, candidateMessageIndex) => {
    if (
      candidateMessageIndex !== messageIndex ||
      !Array.isArray(message.parts)
    ) {
      return message;
    }
    const parts = message.parts.map((part, candidatePartIndex) => {
      if (candidatePartIndex !== partIndex || !isRecord(part)) return part;
      const updated: Record<string, unknown> = {
        ...(part as unknown as Record<string, unknown>),
        data,
      };
      delete updated.content;
      return updated as typeof part;
    });
    return { ...message, parts };
  });
}

/**
 * Apply content safety and tokenization to each canonical value separately.
 * The exact `processedContent` returned by the safety boundary becomes the
 * canonical value used by all downstream copies.
 */
export async function scanCanonicalInlineAttachments(input: {
  messages: UIMessage[];
  sessionId: string;
  safetyProcessor: InlineAttachmentSafetyProcessor;
  onFailure: (error: unknown) => void;
}): Promise<InlineAttachmentSafetyResult> {
  const locations = inlineLocations(input.messages);
  if (
    locations.length === 0 ||
    !input.safetyProcessor.isEnabled()
  ) {
    return {
      messages: input.messages,
      processedValues: locations.map(({ text }) => text),
      tokens: [],
    };
  }
  let messages = input.messages;
  const processedValues: string[] = [];
  const tokens: TokenMapping[] = [];
  let totalProcessedBytes = 0;
  for (const location of locations) {
    const result = await runRequiredSecurityScan(
      () => input.safetyProcessor.processInput(location.text, input.sessionId),
      input.onFailure,
      "Attachment privacy scan failed; the attachment was not processed"
    );
    if (!result.allowed) {
      throw new ContentSafetyBlockedError(
        result.blockedMessage || "Content blocked by safety guardrails",
        result.blockedCategories || [],
        "input"
      );
    }
    if (typeof result.processedContent !== "string") {
      throw new NexusInlineAttachmentValidationError(
        "Processed inline attachment content is invalid"
      );
    }
    totalProcessedBytes += Buffer.byteLength(result.processedContent, "utf8");
    if (totalProcessedBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new NexusInlineAttachmentValidationError(
        "Combined processed inline attachment content exceeds the 25MB limit"
      );
    }
    messages = replaceAtLocation(
      messages,
      location.messageIndex,
      location.partIndex,
      result.processedContent
    );
    processedValues.push(result.processedContent);
    tokens.push(...(result.tokens ?? []));
  }
  return { messages, processedValues, tokens };
}

/**
 * Copy the already-approved canonical values into another representation of
 * the same turn (for example, the persistence or specialist-route copy).
 */
export function applyProcessedInlineAttachmentValues(
  messages: UIMessage[],
  processedValues: readonly string[]
): UIMessage[] {
  const locations = inlineLocations(messages);
  if (locations.length !== processedValues.length) {
    throw new NexusInlineAttachmentValidationError(
      "Inline attachment representations do not match"
    );
  }
  let updated = messages;
  for (const [index, location] of locations.entries()) {
    const processed = processedValues[index];
    if (processed === undefined) {
      throw new NexusInlineAttachmentValidationError(
        "Inline attachment representation is incomplete"
      );
    }
    updated = replaceAtLocation(
      updated,
      location.messageIndex,
      location.partIndex,
      processed
    );
  }
  return updated;
}
