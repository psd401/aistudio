/**
 * Image Generation Handler for Nexus Chat
 * Extracted from route.ts to reduce complexity
 */
import { UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { sql, and, desc, eq } from 'drizzle-orm';
import { executeQuery, executeTransaction } from '@/lib/db/drizzle-client';
import { nexusConversations, nexusMessages } from '@/lib/db/schema';
import { getAttachmentFromS3 } from '@/lib/services/attachment-storage-service';
import { sanitizeTextForDatabase } from '@/lib/utils/text-sanitizer';
import { safeJsonbStringify } from '@/lib/db/json-utils';
import { assertSafeFetchUrl } from '@/lib/agents/agent-tools/web-fetch';
import { createLogger } from '@/lib/logger';

/**
 * A client-supplied reference `s3Key` (or `s3://` URL) must live under the
 * ownership-verified conversation's own attachment prefix (REV-SEC-144). Attachment
 * keys are written as `conversations/${conversationId}/attachments/...`, so any key
 * outside that prefix points at another conversation/user's object and must be
 * rejected before any S3 read.
 */
function isKeyInConversationPrefix(s3Key: string, conversationId: string): boolean {
  return s3Key.startsWith(`conversations/${conversationId}/attachments/`);
}

const log = createLogger({ route: 'api.nexus.chat.image' });

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

interface ReferenceImage {
  base64?: string;
  url?: string;
  s3Key?: string;
  mimeType?: string;
  role?: 'reference' | 'mask';
}

/**
 * Extract text prompt from the last user message
 */
export function extractImagePrompt(messages: ImageGenerationParams['messages']): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return '';
  }

  const messageContent = (lastMessage as UIMessage & {
    content?: string | Array<{ type: string; text?: string }>;
  }).content;

  if (typeof messageContent === 'string') {
    return messageContent.trim();
  }

  if (Array.isArray(messageContent)) {
    const textPart = messageContent.find(part => part.type === 'text' && part.text);
    return (textPart?.text || '').trim();
  }

  if (lastMessage.parts && Array.isArray(lastMessage.parts)) {
    const textPart = lastMessage.parts.find((part) =>
      part.type === 'text' && part.text
    ) as { type: string; text: string } | undefined;
    return (textPart?.text || '').trim();
  }

  return '';
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
export function validateImagePrompt(prompt: string): { valid: boolean; error?: Response } {
  if (prompt.length === 0) {
    return {
      valid: false,
      error: new Response(
        JSON.stringify({ error: 'Image generation requires a text prompt' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  if (prompt.length > 4000) {
    return {
      valid: false,
      error: new Response(
        JSON.stringify({
          error: 'Image prompt is too long. Maximum 4000 characters allowed.',
          maxLength: 4000,
          currentLength: prompt.length
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  return { valid: true };
}

/**
 * Create or get image conversation
 */
export async function getOrCreateImageConversation(params: {
  existingConversationId?: string;
  imagePrompt: string;
  imageProvider: string;
  modelId: string;
  userId: number;
  requestId: string;
}): Promise<{ conversationId: string; title: string } | { error: Response }> {
  const { existingConversationId, imagePrompt, imageProvider, modelId, userId, requestId } = params;

  if (existingConversationId) {
    const owned = await executeQuery(
      (db) => db
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(and(
          eq(nexusConversations.id, existingConversationId),
          eq(nexusConversations.userId, userId)
        ))
        .limit(1),
      'verifyImageConversationOwnership'
    );
    if (!owned || owned.length === 0) {
      log.warn('Image conversation ownership check failed — access denied', { existingConversationId, userId });
      return {
        error: new Response(
          JSON.stringify({ error: 'Conversation not found or access denied', requestId }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      };
    }
    return { conversationId: existingConversationId, title: 'Image Generation' };
  }

  const cleanedPrompt = imagePrompt.replace(/\s+/g, ' ').trim();
  let title = cleanedPrompt.slice(0, 40).trim();
  if (cleanedPrompt.length > 40) {
    title += '...';
  }

  const now = new Date();
  const createResult = await executeQuery(
    (db) => db.insert(nexusConversations)
      .values({
        userId,
        provider: imageProvider,
        modelUsed: modelId,
        title: sanitizeTextForDatabase(title),
        messageCount: 0,
        totalTokens: 0,
        metadata: sql`${safeJsonbStringify({ source: 'nexus', type: 'image-generation' })}::jsonb`,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: nexusConversations.id }),
    'createImageConversation'
  );

  if (!createResult || createResult.length === 0 || !createResult[0]?.id) {
    log.error('Failed to create image conversation');
    return {
      error: new Response(
        JSON.stringify({ error: 'Failed to create conversation' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const conversationId = createResult[0].id as string;
  log.info('Created new image conversation', { conversationId });
  return { conversationId, title };
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
  const { conversationId, imagePrompt, imageResult, dbModelId, routingMetadata = {} } = params;

  // Build assistant parts/content outside the transaction (pure computation).
  const messageParts: Array<{
    type: string;
    text?: string;
    imageUrl?: string;
    s3Key?: string;
    altText?: string;
  }> = [];

  if (imageResult.altText && imageResult.altText.trim()) {
    messageParts.push({ type: 'text', text: imageResult.altText.trim() });
  }

  messageParts.push({
    type: 'image',
    imageUrl: imageResult.imageUrl,
    s3Key: imageResult.s3Key,
    altText: 'Generated image'
  });

  const assistantMessageContent = JSON.stringify({
    type: 'image',
    imageUrl: imageResult.imageUrl,
    s3Key: imageResult.s3Key,
    model: imageResult.model,
    provider: imageResult.provider,
    altText: imageResult.altText,
    dimensions: imageResult.dimensions
  });

  await executeTransaction(async (tx) => {
    await tx.insert(nexusMessages).values({
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content: imagePrompt,
      parts: sql`${safeJsonbStringify([{ type: 'text', text: imagePrompt }])}::jsonb`,
      modelId: dbModelId,
      metadata: sql`${safeJsonbStringify({})}::jsonb`,
      createdAt: new Date()
    });

    await tx.insert(nexusMessages).values({
      conversationId,
      role: 'assistant',
      content: assistantMessageContent,
      parts: sql`${safeJsonbStringify(messageParts)}::jsonb`,
      modelId: dbModelId,
      metadata: sql`${safeJsonbStringify({
        generationType: 'image',
        estimatedCost: imageResult.estimatedCost,
        routing: routingMetadata,
      })}::jsonb`,
      createdAt: new Date()
    });

    // Both rows are inserted in this same transaction, so `+ 2` cannot desync.
    await tx.update(nexusConversations).set({
      messageCount: sql`${nexusConversations.messageCount} + 2`,
      lastMessageAt: new Date(),
      updatedAt: new Date()
    }).where(eq(nexusConversations.id, conversationId));
  }, 'persistImageExchange');
}

/**
 * Extract reference images from message parts
 */
export async function extractReferenceImages(
  lastMessage: ImageGenerationParams['messages'][0] | undefined,
  conversationId: string
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];

  if (!lastMessage) {
    return referenceImages;
  }

  const partsArray = lastMessage.parts as unknown as Array<{
    type: string;
    text?: string;
    image?: string;
    imageUrl?: string;
    s3Key?: string;
    mediaType?: string;
    mimeType?: string;
    data?: string;
    url?: string;
  }> | undefined;

  if (!partsArray || !Array.isArray(partsArray)) {
    return referenceImages;
  }

  for (const part of partsArray) {
    if (part.type === 'image') {
      await handleImagePart(part, referenceImages, conversationId);
    } else if (part.type === 'file') {
      await handleFilePart(part, referenceImages, conversationId);
    }
  }

  return referenceImages;
}

async function handleImagePart(
  part: { s3Key?: string; image?: string; imageUrl?: string },
  referenceImages: ReferenceImage[],
  conversationId: string
): Promise<void> {
  if (part.s3Key) {
    // REV-SEC-144: only read an s3Key that lives under this conversation's own
    // attachment prefix — a client can otherwise reference another tenant's key.
    if (!isKeyInConversationPrefix(part.s3Key, conversationId)) {
      log.warn('Rejected reference image s3Key outside conversation prefix', { conversationId });
      return;
    }
    try {
      const attachmentData = await getAttachmentFromS3(part.s3Key);
      if (attachmentData.image) {
        referenceImages.push({
          base64: attachmentData.image,
          mimeType: attachmentData.contentType,
          role: 'reference'
        });
      }
    } catch (s3Error) {
      log.warn('Failed to retrieve image from S3', {
        s3Key: part.s3Key,
        error: s3Error instanceof Error ? s3Error.message : String(s3Error)
      });
    }
  } else if (part.image && !part.image.startsWith('s3://')) {
    referenceImages.push({ base64: part.image, role: 'reference' });
  } else if (part.image && part.image.startsWith('s3://')) {
    // Before this guard, s3:// images without s3Key would fall through to the
    // imageUrl branch (if present) — silently using a URL that can't resolve.
    // Logging explicitly is safer than a silent fallback to an unusable URL.
    log.warn('Image part has s3:// URL but no s3Key — cannot retrieve');
  } else if (part.imageUrl) {
    // REV-SEC-142: a client-supplied reference URL is fetched server-side
    // downstream; reject private/loopback/link-local/metadata targets (SSRF)
    // before it can become a reference image. https-only in production.
    if (!isSafeReferenceUrl(part.imageUrl)) {
      log.warn('Rejected unsafe reference image URL (SSRF guard)');
      return;
    }
    referenceImages.push({
      url: part.imageUrl,
      role: 'reference'
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
function getS3KeyFromPart(part: { s3Key?: string; url?: string }): string | null {
  if (part.s3Key) return part.s3Key;
  if (part.url && part.url.startsWith('s3://')) return part.url.replace('s3://', '');
  return null;
}

/**
 * Handle S3-based file images
 */
async function handleS3FileImage(
  s3Key: string,
  mimeType: string,
  referenceImages: ReferenceImage[]
): Promise<void> {
  try {
    const attachmentData = await getAttachmentFromS3(s3Key);
    if (attachmentData.image) {
      referenceImages.push({
        base64: attachmentData.image,
        mimeType: attachmentData.contentType || mimeType,
        role: 'reference'
      });
    }
  } catch (s3Error) {
    log.warn('Failed to retrieve file image from S3', {
      s3Key,
      error: s3Error instanceof Error ? s3Error.message : String(s3Error)
    });
  }
}

// SVG intentionally excluded — can embed <script> tags and JS event handlers (XSS vector)
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff',
  'image/avif', 'image/heic', 'image/heif'
]);

async function handleFilePart(
  part: { mediaType?: string; mimeType?: string; s3Key?: string; url?: string; data?: string },
  referenceImages: ReferenceImage[],
  conversationId: string
): Promise<void> {
  const mimeType = part.mediaType || part.mimeType || '';
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    return;
  }

  const s3Key = getS3KeyFromPart(part);
  if (s3Key) {
    // REV-SEC-144: reject a client-supplied key (incl. s3:// URLs) that is not
    // under this conversation's own attachment prefix before any S3 read.
    if (!isKeyInConversationPrefix(s3Key, conversationId)) {
      log.warn('Rejected reference file s3Key outside conversation prefix', { conversationId });
      return;
    }
    await handleS3FileImage(s3Key, mimeType, referenceImages);
    return;
  }

  if (part.data) {
    const base64WithPrefix = part.data.startsWith('data:')
      ? part.data
      : `data:${mimeType};base64,${part.data}`;
    referenceImages.push({ base64: base64WithPrefix, mimeType, role: 'reference' });
    return;
  }

  if (part.url) {
    // REV-SEC-142: part.url here is a non-s3:// URL (getS3KeyFromPart already
    // handled s3://). Reject SSRF targets before it becomes a fetched reference.
    if (!isSafeReferenceUrl(part.url)) {
      log.warn('Rejected unsafe reference file URL (SSRF guard)');
      return;
    }
    referenceImages.push({ url: part.url, mimeType, role: 'reference' });
  }
}

/**
 * Get previous generated images from conversation
 */
export async function getPreviousGeneratedImages(
  conversationId: string,
  userId: number
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];

  const previousImages = await executeQuery(
    (db) => db
      .select({ parts: nexusMessages.parts })
      .from(nexusMessages)
      .innerJoin(
        nexusConversations,
        eq(nexusMessages.conversationId, nexusConversations.id)
      )
      .where(
        and(
          eq(nexusMessages.conversationId, conversationId),
          eq(nexusMessages.role, 'assistant'),
          eq(nexusConversations.userId, userId)
        )
      )
      .orderBy(desc(nexusMessages.createdAt))
      .limit(5),
    'getPreviousGeneratedImages'
  );

  if (!previousImages || previousImages.length === 0) {
    return referenceImages;
  }

  for (const msg of previousImages) {
    if (msg.parts && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        const partData = part as { type: string; imageUrl?: string; s3Key?: string };
        if (partData.type === 'image' && (partData.imageUrl || partData.s3Key)) {
          referenceImages.push({
            url: partData.imageUrl,
            s3Key: partData.s3Key,
            role: 'reference'
          });
          return referenceImages; // Only use most recent
        }
      }
    }
  }

  return referenceImages;
}

/**
 * Determine whether routing can safely treat the current request as having image
 * context. Persisted history is scoped to the authenticated owner because routing
 * runs before the normal conversation ownership check.
 */
export async function getImageRoutingContext(params: {
  messages: ImageGenerationParams['messages'];
  conversationId?: string;
  userId: number;
}): Promise<{ hasImageInput: boolean; hasPreviousGeneratedImage: boolean }> {
  const lastUserMessage = [...params.messages].reverse().find(message => message.role === 'user');
  const hasImageInput = lastUserMessage?.parts?.some(part => {
    const mimeType = part.mimeType ?? part.mediaType;
    return part.type === 'image'
      || (part.type === 'file' && typeof mimeType === 'string' && mimeType.startsWith('image/'));
  }) ?? false;

  if (hasImageInput || !params.conversationId) {
    return { hasImageInput, hasPreviousGeneratedImage: false };
  }

  try {
    const previousImages = await getPreviousGeneratedImages(params.conversationId, params.userId);
    return {
      hasImageInput: false,
      hasPreviousGeneratedImage: previousImages.length > 0,
    };
  } catch (error) {
    // Prior-image context improves routing but is not required for an ordinary
    // chat request. Degrade to no context instead of turning a lookup failure
    // into a pre-stream 500.
    log.warn('Could not load previous image context for routing', {
      conversationId: params.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { hasImageInput: false, hasPreviousGeneratedImage: false };
  }
}

/**
 * Create streaming response for image generation
 */
export function createImageStreamResponse(params: {
  imageResult: { imageUrl: string; altText?: string };
  conversationId: string;
  conversationTitle: string;
  isNewConversation: boolean;
  requestId: string;
  routingMetadata?: Record<string, unknown>;
}): Response {
  const { imageResult, conversationId, conversationTitle, isNewConversation, requestId, routingMetadata } = params;

  let responseContent = '';
  if (imageResult.altText && imageResult.altText.trim()) {
    responseContent += imageResult.altText.trim() + '\n\n';
  }
  responseContent += `![Generated Image](${imageResult.imageUrl})`;

  const messageId = `img-${Date.now()}`;

  const responseHeaders: Record<string, string> = {
    'X-Request-Id': requestId,
    'X-Conversation-Id': conversationId,
    'X-Image-Generated': 'true'
  };

  if (isNewConversation) {
    responseHeaders['X-Conversation-Title'] = encodeURIComponent(conversationTitle);
  }
  if (routingMetadata) {
    const encodedRouting = encodeURIComponent(JSON.stringify(routingMetadata));
    if (encodedRouting.length <= 4096) responseHeaders['X-Nexus-Routing'] = encodedRouting;
  }

  return createUIMessageStreamResponse({
    status: 200,
    headers: responseHeaders,
    stream: createUIMessageStream({
      async execute({ writer }) {
        writer.write({ type: 'text-start', id: messageId });
        writer.write({ type: 'text-delta', id: messageId, delta: responseContent });
        writer.write({ type: 'text-end', id: messageId });
      }
    })
  });
}

/**
 * Handle image generation errors
 */
export function handleImageGenerationError(
  error: unknown,
  conversationId: string,
  requestId: string
): Response {
  // Extract typed error properties with instanceof + in narrowing
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error && 'type' in error ? (error as { type: string }).type : undefined;
  const retryAfter = error instanceof Error && 'retryAfter' in error ? (error as { retryAfter: number }).retryAfter : undefined;

  if (errorType === 'CONTENT_POLICY') {
    // Cap logged message to avoid persisting full user prompt content that providers may echo back
    log.warn('Image generation content policy violation', {
      conversationId,
      errorMessage: errorMessage.slice(0, 200),
      requestId
    });
    return new Response(
      JSON.stringify({ error: 'Your image prompt was flagged by the content policy. Please revise your request.', code: 'CONTENT_POLICY', requestId }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (errorType === 'RATE_LIMIT') {
    log.warn('Image generation rate limited', {
      conversationId,
      errorMessage,
      retryAfter,
      requestId
    });
    return new Response(
      JSON.stringify({
        error: 'Image generation rate limit reached. Please wait and try again.',
        code: 'RATE_LIMIT',
        retryAfter: retryAfter || 60,
        requestId
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (errorType === 'AUTHENTICATION') {
    log.warn('Image generation authentication failure', {
      conversationId,
      errorMessage,
      requestId
    });
    return new Response(
      JSON.stringify({ error: 'Image generation service authentication failed', code: 'AUTH_ERROR', requestId }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Only log at error level for unexpected/untyped errors — not for expected error types above
  log.error('Image generation failed', {
    conversationId,
    errorMessage,
    requestId
  });

  return new Response(
    JSON.stringify({
      error: 'Image generation failed. Please try again.',
      requestId
    }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  );
}
