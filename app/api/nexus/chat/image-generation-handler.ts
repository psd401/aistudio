/**
 * Image Generation Handler for Nexus Chat
 * Extracted from route.ts to reduce complexity
 */
import {
  UIMessage,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { sql, and, desc, eq } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { nexusConversations, nexusMessages } from "@/lib/db/schema";
import { getAttachmentFromS3 } from "@/lib/services/attachment-storage-service";
import { getObjectStream } from "@/lib/aws/s3-client";
import {
  generatedImageKeyPrefix,
  generatedImageProxyPath,
  getGeneratedImageBucket,
} from "@/lib/ai/generated-image-bucket";
import { generatedImageMarkdown } from "@/lib/nexus/generated-image-markdown";
import { safeJsonbStringify } from "@/lib/db/json-utils";
import { assertSafeFetchUrl } from "@/lib/agents/agent-tools/web-fetch";
import { deleteDocumentVersions } from "@/lib/aws/s3-client";
import { createLogger } from "@/lib/logger";
import { describeQueryErrorCause } from "@/lib/db/query-error";
import type { NexusAttachmentImageSource } from "@/lib/nexus/ephemeral-repository-service";
import { isRepositorySourceObjectKey } from "@/lib/repositories/content-platform/object-key";
import { buildNexusStreamHeaders } from "./stream-headers";

/**
 * A client-supplied reference `s3Key` (or `s3://` URL) must live under the
 * ownership-verified conversation's own attachment prefix (REV-SEC-144). Attachment
 * keys are written as `conversations/${conversationId}/attachments/...`, so any key
 * outside that prefix points at another conversation/user's object and must be
 * rejected before any S3 read.
 */
function isKeyInConversationPrefix(
  s3Key: string,
  conversationId: string,
): boolean {
  return s3Key.startsWith(`conversations/${conversationId}/attachments/`);
}

const log = createLogger({ route: "api.nexus.chat.image" });

export interface ImageGenerationParams {
  messages: Array<{
    id: string;
    role: string;
    parts?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    content?: unknown;
  }>;
  modelConfig: {
    provider: string;
    model_id: string;
  };
  modelId: string;
  dbModelId: number;
  userId: number;
  existingConversationId?: string;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
}

/**
 * Remove a generated object when the subsequent durable message transaction
 * fails. The key comes from the server-side image service, but still enforce
 * the conversation-scoped generated-image prefix before deleting anything.
 */
export async function deleteUnpersistedGeneratedImage(params: {
  conversationId: string;
  s3Key?: string;
}): Promise<boolean> {
  const { conversationId, s3Key } = params;
  if (!s3Key || !isGeneratedImageKeyForConversation(s3Key, conversationId)) {
    return false;
  }
  await deleteDocumentVersions(s3Key);
  return true;
}

interface ReferenceImage {
  base64?: string;
  url?: string;
  s3Key?: string;
  mimeType?: string;
  role?: "reference" | "mask";
}

// Cap for any reference image read from S3 (canonical attachment or a previous
// generated image) before it is inlined as base64 for the provider.
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
// SVG intentionally excluded — it can embed scripts and event handlers.
const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/avif",
  "image/heic",
  "image/heif",
]);

function invalidCanonicalImage(message: string): Error {
  return Object.assign(new Error(message), { type: "INVALID_ATTACHMENT" });
}

/**
 * Read an object from S3 into memory, refusing anything over
 * MAX_REFERENCE_IMAGE_BYTES (checked against Content-Length, then while reading).
 * `bucket` defaults to the Settings-resolved documents bucket.
 */
async function readReferenceObject(
  objectKey: string,
  tooLarge: () => Error,
  bucket?: string,
): Promise<{ bytes: Buffer; contentType?: string }> {
  const object = await getObjectStream(objectKey, bucket);
  if (
    object.contentLength != null &&
    object.contentLength > MAX_REFERENCE_IMAGE_BYTES
  ) {
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of object.stream) {
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REFERENCE_IMAGE_BYTES) {
      object.stream.destroy();
      throw tooLarge();
    }
    chunks.push(buffer);
  }
  return { bytes: Buffer.concat(chunks), contentType: object.contentType };
}

/** Lower-cased media type without parameters (`image/png; x=y` -> `image/png`). */
function bareMimeType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function loadCanonicalRepositoryImage(
  source: NexusAttachmentImageSource,
): Promise<ReferenceImage> {
  if (!isRepositorySourceObjectKey(source.repositoryId, source.objectKey)) {
    throw invalidCanonicalImage("Canonical image source is invalid");
  }
  if (
    source.byteSize != null &&
    source.byteSize > MAX_REFERENCE_IMAGE_BYTES
  ) {
    throw invalidCanonicalImage("Canonical image source is too large");
  }

  const object = await readReferenceObject(source.objectKey, () =>
    invalidCanonicalImage("Canonical image source is too large"),
  );

  const mimeType = bareMimeType(
    source.detectedContentType ??
      object.contentType ??
      source.declaredContentType ??
      "",
  );
  if (!mimeType || !ALLOWED_IMAGE_MIMES.has(mimeType)) {
    throw invalidCanonicalImage("Canonical image source is not an image");
  }
  return {
    base64: `data:${mimeType};base64,${object.bytes.toString("base64")}`,
    mimeType,
    role: "reference",
  };
}

/** Server-written key prefix for a conversation's generated images. */
function isGeneratedImageKeyForConversation(
  s3Key: string,
  conversationId: string,
): boolean {
  return s3Key.startsWith(generatedImageKeyPrefix(conversationId));
}

/**
 * Turn a previous generated image into inline bytes read from its durable S3
 * object. The persisted `imageUrl` is a presigned link that expires one hour
 * after generation, so fetching it for a later edit returns 403 from S3 (seen in
 * prod 2026-09-23: a user returned 18 hours later, every edit failed with HTTP
 * 500). Only keys under this conversation's own generated-images prefix are read;
 * anything else, or a failed read, keeps the stored reference unchanged.
 */
async function hydratePreviousGeneratedImage(
  ref: ReferenceImage,
  conversationId: string,
): Promise<ReferenceImage> {
  if (!ref.s3Key) {
    return ref;
  }
  if (!isGeneratedImageKeyForConversation(ref.s3Key, conversationId)) {
    log.warn("Previous generated image key is outside this conversation's prefix", {
      conversationId,
    });
    return ref;
  }
  try {
    // Read from the bucket the image was written to (storeImageInS3), not the
    // Settings-resolved bucket the generic S3 client would pick.
    const object = await readReferenceObject(
      ref.s3Key,
      () => new Error("Previous generated image is too large"),
      getGeneratedImageBucket(),
    );
    const mimeType = bareMimeType(object.contentType);
    if (!mimeType || !ALLOWED_IMAGE_MIMES.has(mimeType)) {
      log.warn("Previous generated image is not an allowed image type; using stored URL", {
        conversationId,
        mimeType,
      });
      return ref;
    }
    return {
      base64: `data:${mimeType};base64,${object.bytes.toString("base64")}`,
      mimeType,
      s3Key: ref.s3Key,
      role: "reference",
    };
  } catch (error) {
    log.warn("Could not read previous generated image from S3; using stored URL", {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return ref;
  }
}

/**
 * Load the exact immutable repository versions resolved for canonical markers.
 * Caller-supplied inline pixels are deliberately ignored whenever markers are
 * present, preventing marker A from being paired with unrelated image B.
 */
export async function extractCanonicalRepositoryImages(
  sources: readonly NexusAttachmentImageSource[],
): Promise<ReferenceImage[]> {
  const images: ReferenceImage[] = [];
  for (const source of sources) {
    images.push(await loadCanonicalRepositoryImage(source));
  }
  return images;
}

/**
 * Extract text prompt from the last user message
 */
export function extractImagePrompt(
  messages: ImageGenerationParams["messages"],
): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    return "";
  }

  const messageContent = (
    lastMessage as UIMessage & {
      content?: string | Array<{ type: string; text?: string }>;
    }
  ).content;

  if (typeof messageContent === "string") {
    return messageContent.trim();
  }

  if (Array.isArray(messageContent)) {
    const textPart = messageContent.find(
      (part) => part.type === "text" && part.text,
    );
    return (textPart?.text || "").trim();
  }

  if (lastMessage.parts && Array.isArray(lastMessage.parts)) {
    const textPart = lastMessage.parts.find(
      (part) => part.type === "text" && part.text,
    ) as { type: string; text: string } | undefined;
    return (textPart?.text || "").trim();
  }

  return "";
}

/**
 * Validate image prompt length only.
 *
 * Content moderation is the upstream provider's job (and Bedrock guardrails
 * for Bedrock-routed providers). The previous naive substring blocklist
 * blocked legitimate educational prompts — a history teacher asking for
 * "a Civil War weapon", a science teacher asking for "blood cells", a
 * health curriculum asking about "death" or "harm reduction" — and produced
 * the "Image prompt violates content policy" surfaced to users.
 */
export function validateImagePrompt(prompt: string): {
  valid: boolean;
  error?: Response;
} {
  if (prompt.length === 0) {
    return {
      valid: false,
      error: new Response(
        JSON.stringify({ error: "Image generation requires a text prompt" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (prompt.length > 4000) {
    return {
      valid: false,
      error: new Response(
        JSON.stringify({
          error: "Image prompt is too long. Maximum 4000 characters allowed.",
          maxLength: 4000,
          currentLength: prompt.length,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { valid: true };
}

/**
 * Persist an image-generation exchange atomically (REV-DB-047 / REV-COR-220).
 *
 * The user-prompt row, the assistant image row, and the conversation-stats
 * increment previously ran as three independent queries with a hardcoded
 * `message_count + 2`, so a failure between them left the counter out of sync with
 * the actual rows. Wrapping all three in one executeTransaction makes the `+2`
 * guaranteed correct (both rows are inserted in the same unit). Image generation
 * and S3 access are side effects and stay OUTSIDE this transaction — only the DB
 * writes are inside.
 */
export async function persistImageExchange(params: {
  conversationId: string;
  imagePrompt: string;
  userContent?: string;
  userParts?: unknown[];
  imageResult: {
    imageUrl: string;
    s3Key?: string;
    model?: string;
    provider?: string;
    altText?: string;
    dimensions?: { width: number; height: number };
    estimatedCost?: number;
  };
  dbModelId: number;
  routingMetadata?: Record<string, unknown>;
}): Promise<void> {
  const {
    conversationId,
    imagePrompt,
    userContent = imagePrompt,
    userParts = [{ type: "text", text: imagePrompt }],
    imageResult,
    dbModelId,
    routingMetadata = {},
  } = params;

  // Build assistant parts/content outside the transaction (pure computation).
  const messageParts: Array<{
    type: string;
    text?: string;
    imageUrl?: string;
    s3Key?: string;
    altText?: string;
  }> = [];

  if (imageResult.altText && imageResult.altText.trim()) {
    messageParts.push({ type: "text", text: imageResult.altText.trim() });
  }

  messageParts.push({
    type: "image",
    imageUrl: imageResult.imageUrl,
    s3Key: imageResult.s3Key,
    // The reload path renders this as the image's alt text (#1900).
    altText: imageResult.altText?.trim() || "Generated image",
  });

  const assistantMessageContent = JSON.stringify({
    type: "image",
    imageUrl: imageResult.imageUrl,
    s3Key: imageResult.s3Key,
    model: imageResult.model,
    provider: imageResult.provider,
    altText: imageResult.altText,
    dimensions: imageResult.dimensions,
  });

  await persistExchangeRows({
    conversationId,
    userContent,
    userParts,
    assistantContent: assistantMessageContent,
    assistantParts: messageParts,
    assistantMetadata: {
      generationType: "image",
      estimatedCost: imageResult.estimatedCost,
      routing: routingMetadata,
    },
    dbModelId,
    label: "persistImageExchange",
  });
}

/**
 * Insert the user turn, the assistant turn, and the conversation-stats bump as
 * ONE transaction.
 *
 * These previously ran as three independent queries with a hardcoded
 * `message_count + 2`, so a failure between them left the counter out of sync
 * with the actual rows. Both rows are inserted in this same unit, so the `+ 2`
 * is guaranteed correct. Image generation and S3 access are side effects and
 * stay OUTSIDE this transaction — only the DB writes are inside.
 */
async function persistExchangeRows(params: {
  conversationId: string;
  userContent: string;
  userParts: unknown[];
  assistantContent: string;
  assistantParts: unknown[];
  assistantMetadata: Record<string, unknown>;
  dbModelId: number;
  label: string;
}): Promise<void> {
  const { conversationId, dbModelId } = params;
  await executeTransaction(async (tx) => {
    await tx.insert(nexusMessages).values({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: params.userContent,
      parts: sql`${safeJsonbStringify(params.userParts)}::jsonb`,
      modelId: dbModelId,
      metadata: sql`${safeJsonbStringify({})}::jsonb`,
      createdAt: new Date(),
    });

    await tx.insert(nexusMessages).values({
      conversationId,
      role: "assistant",
      content: params.assistantContent,
      parts: sql`${safeJsonbStringify(params.assistantParts)}::jsonb`,
      modelId: dbModelId,
      metadata: sql`${safeJsonbStringify(params.assistantMetadata)}::jsonb`,
      createdAt: new Date(),
    });

    // Both rows are inserted in this same transaction, so `+ 2` cannot desync.
    await tx
      .update(nexusConversations)
      .set({
        messageCount: sql`${nexusConversations.messageCount} + 2`,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(nexusConversations.id, conversationId));
  }, params.label);
}

/**
 * Persist a turn where the model answered in words instead of pixels (#1900).
 *
 * Stored as an ordinary assistant text message so the explanation survives a
 * reload exactly like any other reply, rather than being a toast the user
 * cannot get back.
 */
export async function persistNoImageExchange(params: {
  conversationId: string;
  userContent: string;
  userParts: unknown[];
  assistantText: string;
  dbModelId: number;
  routingMetadata?: Record<string, unknown>;
}): Promise<void> {
  await persistExchangeRows({
    conversationId: params.conversationId,
    userContent: params.userContent,
    userParts: params.userParts,
    assistantContent: params.assistantText,
    assistantParts: [{ type: "text", text: params.assistantText }],
    assistantMetadata: {
      generationType: "image-no-image",
      routing: params.routingMetadata ?? {},
    },
    dbModelId: params.dbModelId,
    label: "persistNoImageExchange",
  });
}

/**
 * Extract reference images from message parts
 */
export async function extractReferenceImages(
  lastMessage: ImageGenerationParams["messages"][0] | undefined,
  conversationId: string,
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];

  if (!lastMessage) {
    return referenceImages;
  }

  const partsArray = lastMessage.parts as unknown as
    | Array<{
        type: string;
        text?: string;
        image?: string;
        imageUrl?: string;
        s3Key?: string;
        mediaType?: string;
        mimeType?: string;
        data?: string;
        url?: string;
      }>
    | undefined;

  if (!partsArray || !Array.isArray(partsArray)) {
    return referenceImages;
  }

  for (const part of partsArray) {
    if (part.type === "image") {
      await handleImagePart(part, referenceImages, conversationId);
    } else if (part.type === "file") {
      await handleFilePart(part, referenceImages, conversationId);
    }
  }

  return referenceImages;
}

async function handleImagePart(
  part: { s3Key?: string; image?: string; imageUrl?: string },
  referenceImages: ReferenceImage[],
  conversationId: string,
): Promise<void> {
  if (part.s3Key) {
    // REV-SEC-144: only read an s3Key that lives under this conversation's own
    // attachment prefix — a client can otherwise reference another tenant's key.
    if (!isKeyInConversationPrefix(part.s3Key, conversationId)) {
      log.warn("Rejected reference image s3Key outside conversation prefix", {
        conversationId,
      });
      return;
    }
    try {
      const attachmentData = await getAttachmentFromS3(part.s3Key);
      if (attachmentData.image) {
        referenceImages.push({
          base64: attachmentData.image,
          mimeType: attachmentData.contentType,
          role: "reference",
        });
      }
    } catch (s3Error) {
      log.warn("Failed to retrieve image from S3", {
        s3Key: part.s3Key,
        error: s3Error instanceof Error ? s3Error.message : String(s3Error),
      });
    }
  } else if (part.image && !part.image.startsWith("s3://")) {
    referenceImages.push({ base64: part.image, role: "reference" });
  } else if (part.image && part.image.startsWith("s3://")) {
    // Before this guard, s3:// images without s3Key would fall through to the
    // imageUrl branch (if present) — silently using a URL that can't resolve.
    // Logging explicitly is safer than a silent fallback to an unusable URL.
    log.warn("Image part has s3:// URL but no s3Key — cannot retrieve");
  } else if (part.imageUrl) {
    // REV-SEC-142: a client-supplied reference URL is fetched server-side
    // downstream; reject private/loopback/link-local/metadata targets (SSRF)
    // before it can become a reference image. https-only in production.
    if (!isSafeReferenceUrl(part.imageUrl)) {
      log.warn("Rejected unsafe reference image URL (SSRF guard)");
      return;
    }
    referenceImages.push({
      url: part.imageUrl,
      role: "reference",
    });
  }
}

/**
 * SSRF guard for a client-supplied reference-image URL (REV-SEC-142). Wraps the
 * shared assertSafeFetchUrl (blocks private/loopback/link-local/metadata hosts;
 * https-only in production) and returns a boolean so callers can skip+log.
 */
function isSafeReferenceUrl(url: string): boolean {
  try {
    assertSafeFetchUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get S3 key from part data
 */
function getS3KeyFromPart(part: {
  s3Key?: string;
  url?: string;
}): string | null {
  if (part.s3Key) return part.s3Key;
  if (part.url && part.url.startsWith("s3://"))
    return part.url.replace("s3://", "");
  return null;
}

/**
 * Handle S3-based file images
 */
async function handleS3FileImage(
  s3Key: string,
  mimeType: string,
  referenceImages: ReferenceImage[],
): Promise<void> {
  try {
    const attachmentData = await getAttachmentFromS3(s3Key);
    if (attachmentData.image) {
      referenceImages.push({
        base64: attachmentData.image,
        mimeType: attachmentData.contentType || mimeType,
        role: "reference",
      });
    }
  } catch (s3Error) {
    log.warn("Failed to retrieve file image from S3", {
      s3Key,
      error: s3Error instanceof Error ? s3Error.message : String(s3Error),
    });
  }
}

async function handleFilePart(
  part: {
    mediaType?: string;
    mimeType?: string;
    s3Key?: string;
    url?: string;
    data?: string;
  },
  referenceImages: ReferenceImage[],
  conversationId: string,
): Promise<void> {
  const mimeType = part.mediaType || part.mimeType || "";
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    return;
  }

  const s3Key = getS3KeyFromPart(part);
  if (s3Key) {
    // REV-SEC-144: reject a client-supplied key (incl. s3:// URLs) that is not
    // under this conversation's own attachment prefix before any S3 read.
    if (!isKeyInConversationPrefix(s3Key, conversationId)) {
      log.warn("Rejected reference file s3Key outside conversation prefix", {
        conversationId,
      });
      return;
    }
    await handleS3FileImage(s3Key, mimeType, referenceImages);
    return;
  }

  if (part.data) {
    const base64WithPrefix = part.data.startsWith("data:")
      ? part.data
      : `data:${mimeType};base64,${part.data}`;
    referenceImages.push({
      base64: base64WithPrefix,
      mimeType,
      role: "reference",
    });
    return;
  }

  if (part.url) {
    // REV-SEC-142: part.url here is a non-s3:// URL (getS3KeyFromPart already
    // handled s3://). Reject SSRF targets before it becomes a fetched reference.
    if (!isSafeReferenceUrl(part.url)) {
      log.warn("Rejected unsafe reference file URL (SSRF guard)");
      return;
    }
    referenceImages.push({ url: part.url, mimeType, role: "reference" });
  }
}

/**
 * Get previous generated images from conversation
 */
export async function getPreviousGeneratedImages(
  conversationId: string,
  userId: number,
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];

  const previousImages = await executeQuery(
    (db) =>
      db
        .select({ parts: nexusMessages.parts })
        .from(nexusMessages)
        .innerJoin(
          nexusConversations,
          eq(nexusMessages.conversationId, nexusConversations.id),
        )
        .where(
          and(
            eq(nexusMessages.conversationId, conversationId),
            eq(nexusMessages.role, "assistant"),
            eq(nexusConversations.userId, userId),
          ),
        )
        .orderBy(desc(nexusMessages.createdAt))
        .limit(5),
    "getPreviousGeneratedImages",
  );

  if (!previousImages || previousImages.length === 0) {
    return referenceImages;
  }

  for (const msg of previousImages) {
    if (msg.parts && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        const partData = part as {
          type: string;
          imageUrl?: string;
          s3Key?: string;
        };
        if (
          partData.type === "image" &&
          (partData.imageUrl || partData.s3Key)
        ) {
          referenceImages.push({
            url: partData.imageUrl,
            s3Key: partData.s3Key,
            role: "reference",
          });
          return referenceImages; // Only use most recent
        }
      }
    }
  }

  return referenceImages;
}

/**
 * The most recent generated image in an owned conversation, ready to send as an
 * edit reference: the image bytes are read from S3 by key instead of via the
 * stored presigned `imageUrl`, which stops working an hour after generation.
 * Routing only needs to know an image exists, so it keeps calling
 * `getPreviousGeneratedImages` and never downloads the object.
 */
export async function resolvePreviousGeneratedImageReferences(
  conversationId: string,
  userId: number,
): Promise<ReferenceImage[]> {
  const previous = await getPreviousGeneratedImages(conversationId, userId);
  return Promise.all(
    previous.map((ref) => hydratePreviousGeneratedImage(ref, conversationId)),
  );
}

/**
 * Determine whether routing can safely treat the current request as having image
 * context. Persisted history is scoped to the authenticated owner because routing
 * runs before the normal conversation ownership check.
 */
export async function getImageRoutingContext(params: {
  messages: ImageGenerationParams["messages"];
  conversationId?: string;
  userId: number;
}): Promise<{
  hasImageInput: boolean;
  hasNonImageFileInput: boolean;
  hasPreviousGeneratedImage: boolean;
}> {
  const lastUserMessage = [...params.messages]
    .reverse()
    .find((message) => message.role === "user");
  const parts = lastUserMessage?.parts ?? [];
  const isImagePart = (part: (typeof parts)[number]): boolean => {
    const mimeType = part.mimeType ?? part.mediaType;
    return (
      part.type === "image" ||
      (part.type === "file" &&
        typeof mimeType === "string" &&
        mimeType.startsWith("image/"))
    );
  };
  const hasImageInput = parts.some(isImagePart);
  // An inline PDF or document beside the image: the image path cannot read it.
  const hasNonImageFileInput = parts.some(
    (part) => part.type === "file" && !isImagePart(part),
  );

  if (hasImageInput || !params.conversationId) {
    return { hasImageInput, hasNonImageFileInput, hasPreviousGeneratedImage: false };
  }

  try {
    const previousImages = await getPreviousGeneratedImages(
      params.conversationId,
      params.userId,
    );
    return {
      hasImageInput: false,
      hasNonImageFileInput,
      hasPreviousGeneratedImage: previousImages.length > 0,
    };
  } catch (error) {
    // Prior-image context improves routing but is not required for an ordinary
    // chat request. Degrade to no context instead of turning a lookup failure
    // into a pre-stream 500.
    log.warn("Could not load previous image context for routing", {
      conversationId: params.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      hasImageInput: false,
      hasNonImageFileInput,
      hasPreviousGeneratedImage: false,
    };
  }
}

/**
 * Create streaming response for image generation
 */
export function createImageStreamResponse(params: {
  imageResult: { imageUrl: string; s3Key?: string; altText?: string };
  conversationId: string;
  conversationTitle: string;
  isNewConversation: boolean;
  requestId: string;
  routingMetadata?: Record<string, unknown>;
}): Response {
  const { imageResult } = params;

  let responseContent = "";
  if (imageResult.altText && imageResult.altText.trim()) {
    responseContent += imageResult.altText.trim() + "\n\n";
  }
  // Render through the authenticated proxy, not the raw presigned URL the
  // provider call returned: the proxy is what still works after this hour and
  // after a reload, so the live turn and the reloaded turn show the same URL
  // (#1900). Pre-#1900 rows carry no `s3Key`, so they keep the presigned link.
  const renderedUrl = imageResult.s3Key
    ? generatedImageProxyPath(imageResult.s3Key)
    : imageResult.imageUrl;
  responseContent += generatedImageMarkdown(renderedUrl, imageResult.altText);

  return createAssistantTextStreamResponse({
    text: responseContent,
    messageIdPrefix: "img",
    imageGenerated: true,
    conversationId: params.conversationId,
    conversationTitle: params.conversationTitle,
    isNewConversation: params.isNewConversation,
    requestId: params.requestId,
    routingMetadata: params.routingMetadata,
  });
}

/** Stream one complete assistant text message as a normal Nexus turn. */
function createAssistantTextStreamResponse(params: {
  text: string;
  messageIdPrefix: string;
  imageGenerated: boolean;
  conversationId: string;
  conversationTitle: string;
  isNewConversation: boolean;
  requestId: string;
  routingMetadata?: Record<string, unknown>;
}): Response {
  const messageId = `${params.messageIdPrefix}-${Date.now()}`;

  const responseHeaders = buildNexusStreamHeaders({
    requestId: params.requestId,
    routingMetadata: params.routingMetadata,
    conversationId: params.conversationId,
    conversationTitle: params.isNewConversation
      ? params.conversationTitle
      : undefined,
    extraHeaders: params.imageGenerated ? { "X-Image-Generated": "true" } : undefined,
  });

  return createUIMessageStreamResponse({
    status: 200,
    headers: responseHeaders,
    stream: createUIMessageStream({
      async execute({ writer }) {
        writer.write({ type: "text-start", id: messageId });
        writer.write({
          type: "text-delta",
          id: messageId,
          delta: params.text,
        });
        writer.write({ type: "text-end", id: messageId });
      },
    }),
  });
}

/**
 * The label that tells the user no image came back, however good the text is.
 * Same vocabulary as the "Image unavailable" fallback in `markdown-text.tsx`.
 */
export const NO_IMAGE_LABEL = "**Image not generated.**";

/**
 * The model's own words when it answered an image request with text (#1900).
 *
 * Only a `NO_IMAGE` that carries `providerText` qualifies. `NO_IMAGE` is also
 * thrown for a reference image that is too large, a blocked or failing
 * reference URL, and an empty provider response; those are failures, not
 * answers, so they return `null` and keep the error path and its rollback.
 */
export function getNoImageExplanation(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    !("type" in error) ||
    (error as { type?: unknown }).type !== "NO_IMAGE" ||
    !("providerText" in error)
  ) {
    return null;
  }
  const text = String((error as { providerText?: unknown }).providerText ?? "").trim();
  return text || null;
}

/**
 * The user-facing text for a model that explained instead of drawing (#1900).
 *
 * The explanation is the valuable part — "I can't render recognisable
 * people", "that photo is too small to upscale" — so it is shown verbatim
 * under a label that makes the missing image unambiguous.
 */
export function buildNoImageMessage(explanation: string): string {
  return `${NO_IMAGE_LABEL}\n\n${explanation}`;
}

/**
 * Return a `NO_IMAGE` result as a readable assistant turn instead of a 500.
 *
 * A generic "Image generation failed. Please try again." threw away a reply
 * that already told the user exactly why retrying would not help.
 */
export function createNoImageResponse(params: {
  text: string;
  conversationId: string;
  conversationTitle: string;
  isNewConversation: boolean;
  requestId: string;
  routingMetadata?: Record<string, unknown>;
}): Response {
  return createAssistantTextStreamResponse({
    text: params.text,
    messageIdPrefix: "no-img",
    imageGenerated: false,
    conversationId: params.conversationId,
    conversationTitle: params.conversationTitle,
    isNewConversation: params.isNewConversation,
    requestId: params.requestId,
    routingMetadata: params.routingMetadata,
  });
}

/**
 * Decide the response for an image turn whose generation threw (#1900).
 *
 * A model that answered in words instead of pixels did NOT fail the turn: its
 * explanation is saved and shown. Everything else — a `NO_IMAGE` the model did
 * not explain, any other error, or an explanation that could not be saved (a
 * reply that would vanish on reload, over a new conversation left with no
 * messages) — rolls back a newly created conversation and returns the error
 * response. The route supplies the side effects so this decision is testable.
 */
export async function respondToImageFailure(params: {
  error: unknown;
  /** Saves and streams the explanation; throws if it cannot be saved. */
  replyWithExplanation: (explanation: string) => Promise<Response>;
  /** Compensates a new conversation; returns a response only if that fails. */
  rollback: () => Promise<Response | null>;
  toErrorResponse: (error: unknown) => Response;
  conversationId: string;
}): Promise<Response> {
  let failure: unknown = params.error;
  const explanation = getNoImageExplanation(params.error);
  if (explanation) {
    try {
      return await params.replyWithExplanation(explanation);
    } catch (persistError) {
      log.error("Failed to persist a no-image image turn", {
        conversationId: params.conversationId,
        error:
          persistError instanceof Error
            ? persistError.message
            : "Unknown persistence error",
        ...describeQueryErrorCause(persistError),
      });
      failure = persistError;
    }
  }
  const rollbackError = await params.rollback();
  return rollbackError ?? params.toErrorResponse(failure);
}

/**
 * Handle image generation errors
 */
export function handleImageGenerationError(
  error: unknown,
  conversationId: string,
  requestId: string,
): Response {
  // Extract typed error properties with instanceof + in narrowing
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType =
    error instanceof Error && "type" in error
      ? (error as { type: string }).type
      : undefined;
  const retryAfter =
    error instanceof Error && "retryAfter" in error
      ? (error as { retryAfter: number }).retryAfter
      : undefined;

  if (errorType === "CONTENT_POLICY") {
    // Cap logged message to avoid persisting full user prompt content that providers may echo back
    log.warn("Image generation content policy violation", {
      conversationId,
      errorMessage: errorMessage.slice(0, 200),
      requestId,
    });
    return new Response(
      JSON.stringify({
        error:
          "Your image prompt was flagged by the content policy. Please revise your request.",
        code: "CONTENT_POLICY",
        requestId,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (errorType === "RATE_LIMIT") {
    log.warn("Image generation rate limited", {
      conversationId,
      errorMessage,
      retryAfter,
      requestId,
    });
    return new Response(
      JSON.stringify({
        error:
          "Image generation rate limit reached. Please wait and try again.",
        code: "RATE_LIMIT",
        retryAfter: retryAfter || 60,
        requestId,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  if (errorType === "AUTHENTICATION") {
    log.warn("Image generation authentication failure", {
      conversationId,
      errorMessage,
      requestId,
    });
    return new Response(
      JSON.stringify({
        error: "Image generation service authentication failed",
        code: "AUTH_ERROR",
        requestId,
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  if (errorType === "INVALID_ATTACHMENT") {
    log.warn("Image generation canonical attachment rejected", {
      conversationId,
      errorMessage,
      requestId,
    });
    return new Response(
      JSON.stringify({
        error:
          "The attached repository image is unavailable for image generation.",
        code: "INVALID_ATTACHMENT",
        requestId,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Only log at error level for unexpected/untyped errors — not for expected error types above
  log.error("Image generation failed", {
    conversationId,
    errorMessage,
    requestId,
  });

  return new Response(
    JSON.stringify({
      error: "Image generation failed. Please try again.",
      requestId,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}
