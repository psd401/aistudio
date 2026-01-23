/**
 * Image Generation Handler for Nexus Chat
 * Extracted from route.ts to reduce complexity
 */
import { UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { sql, and, desc, eq } from 'drizzle-orm';
import { executeQuery } from '@/lib/db/drizzle-client';
import { nexusConversations, nexusMessages } from '@/lib/db/schema';
import { getAttachmentFromS3 } from '@/lib/services/attachment-storage-service';
import { sanitizeTextForDatabase } from '@/lib/utils/text-sanitizer';
import { safeJsonbStringify } from '@/lib/db/json-utils';
import { createLogger } from '@/lib/logger';

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
 * Validate image prompt for length and content policy
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

  const lowercasePrompt = prompt.toLowerCase();
  const forbiddenPatterns = [
    'nude', 'naked', 'nsfw', 'explicit', 'sexual', 'porn', 'erotic',
    'violence', 'blood', 'gore', 'weapon', 'harm', 'kill', 'death',
    'hate', 'racist', 'discriminatory', 'offensive'
  ];

  if (forbiddenPatterns.some(pattern => lowercasePrompt.includes(pattern))) {
    return {
      valid: false,
      error: new Response(
        JSON.stringify({
          error: 'Image prompt violates content policy. Please revise your request.'
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
}): Promise<{ conversationId: string; title: string } | { error: Response }> {
  const { existingConversationId, imagePrompt, imageProvider, modelId, userId } = params;

  if (existingConversationId) {
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
 * Save user message for image generation
 */
export async function saveImageUserMessage(params: {
  conversationId: string;
  imagePrompt: string;
  dbModelId: number;
}): Promise<void> {
  const { conversationId, imagePrompt, dbModelId } = params;

  await executeQuery(
    (db) => db.insert(nexusMessages)
      .values({
        id: crypto.randomUUID(),
        conversationId,
        role: 'user',
        content: imagePrompt,
        parts: sql`${safeJsonbStringify([{ type: 'text', text: imagePrompt }])}::jsonb`,
        modelId: dbModelId,
        metadata: sql`${safeJsonbStringify({})}::jsonb`,
        createdAt: new Date()
      }),
    'saveImageUserMessage'
  );
}

/**
 * Extract reference images from message parts
 */
export async function extractReferenceImages(
  lastMessage: ImageGenerationParams['messages'][0]
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];

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
      await handleImagePart(part, referenceImages);
    } else if (part.type === 'file') {
      await handleFilePart(part, referenceImages);
    }
  }

  return referenceImages;
}

async function handleImagePart(
  part: { s3Key?: string; image?: string; imageUrl?: string },
  referenceImages: ReferenceImage[]
): Promise<void> {
  if (part.s3Key) {
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
  } else if (part.imageUrl) {
    referenceImages.push({
      url: part.imageUrl,
      s3Key: part.s3Key,
      role: 'reference'
    });
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

async function handleFilePart(
  part: { mediaType?: string; mimeType?: string; s3Key?: string; url?: string; data?: string },
  referenceImages: ReferenceImage[]
): Promise<void> {
  const mimeType = part.mediaType || part.mimeType || '';
  if (!mimeType.startsWith('image/')) {
    return;
  }

  const s3Key = getS3KeyFromPart(part);
  if (s3Key) {
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
    referenceImages.push({ url: part.url, mimeType, role: 'reference' });
  }
}

/**
 * Get previous generated images from conversation
 */
export async function getPreviousGeneratedImages(
  conversationId: string
): Promise<ReferenceImage[]> {
  const referenceImages: ReferenceImage[] = [];

  const previousImages = await executeQuery(
    (db) => db
      .select({ parts: nexusMessages.parts })
      .from(nexusMessages)
      .where(
        and(
          eq(nexusMessages.conversationId, conversationId),
          eq(nexusMessages.role, 'assistant')
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
 * Save assistant message with generated image
 */
export async function saveImageAssistantMessage(params: {
  conversationId: string;
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
}): Promise<void> {
  const { conversationId, imageResult, dbModelId } = params;

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

  await executeQuery(
    (db) => db.insert(nexusMessages)
      .values({
        conversationId,
        role: 'assistant',
        content: assistantMessageContent,
        parts: sql`${safeJsonbStringify(messageParts)}::jsonb`,
        modelId: dbModelId,
        metadata: sql`${safeJsonbStringify({
          generationType: 'image',
          estimatedCost: imageResult.estimatedCost
        })}::jsonb`,
        createdAt: new Date()
      }),
    'saveImageAssistantMessage'
  );
}

/**
 * Update conversation stats after image generation
 */
export async function updateImageConversationStats(conversationId: string): Promise<void> {
  await executeQuery(
    (db) => db.update(nexusConversations)
      .set({
        messageCount: sql`${nexusConversations.messageCount} + 2`,
        lastMessageAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(nexusConversations.id, conversationId)),
    'updateImageConversationStats'
  );
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
}): Response {
  const { imageResult, conversationId, conversationTitle, isNewConversation, requestId } = params;

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
  log.error('Image generation failed', {
    error: error instanceof Error ? error.message : String(error),
    conversationId
  });

  const typedError = error as Error & { type?: string; retryAfter?: number };

  if (typedError.type === 'CONTENT_POLICY') {
    return new Response(
      JSON.stringify({ error: typedError.message, code: 'CONTENT_POLICY' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (typedError.type === 'RATE_LIMIT') {
    return new Response(
      JSON.stringify({
        error: typedError.message,
        code: 'RATE_LIMIT',
        retryAfter: typedError.retryAfter || 60
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (typedError.type === 'AUTHENTICATION') {
    return new Response(
      JSON.stringify({ error: 'Image generation service authentication failed', code: 'AUTH_ERROR' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      error: 'Image generation failed. Please try again.',
      details: typedError.message,
      requestId
    }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  );
}
