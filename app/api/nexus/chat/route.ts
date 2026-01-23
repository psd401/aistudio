import { UIMessage } from 'ai';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getAIModelById } from '@/lib/db/drizzle';
import { hasCapability } from '@/lib/ai/capability-utils';
import { processMessagesWithAttachments } from '@/lib/services/attachment-storage-service';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import type { StreamRequest } from '@/lib/streaming/types';
import { ContentSafetyBlockedError } from '@/lib/streaming/types';
import { getModelConfig } from '@/lib/ai/model-config';

import {
  extractImagePrompt,
  validateImagePrompt,
  getOrCreateImageConversation,
  saveImageUserMessage,
  extractReferenceImages,
  getPreviousGeneratedImages,
  saveImageAssistantMessage,
  updateImageConversationStats,
  createImageStreamResponse,
  handleImageGenerationError,
} from './image-generation-handler';

import {
  generateConversationTitle,
  createConversation,
  extractUserContent,
  saveUserMessage,
  convertMessagesToPartsFormat,
  saveAssistantMessage,
} from './chat-helpers';

// Allow streaming responses up to 5 minutes for long-running conversations
export const maxDuration = 300;

/**
 * Build the onFinish callback for streaming
 */
function createOnFinishCallback(params: {
  conversationId: string;
  dbModelId: number;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
}) {
  const { conversationId, dbModelId, log, timer } = params;

  return async ({
    text,
    usage,
    finishReason,
    toolCalls
  }: {
    text: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    finishReason?: string;
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
    }>;
  }) => {
    log.info('Stream finished, saving assistant message', {
      conversationId,
      hasText: !!text,
      textLength: text?.length || 0,
      toolCallCount: toolCalls?.length || 0
    });

    try {
      await saveAssistantMessage({ conversationId, text, usage, finishReason, toolCalls, dbModelId });
    } catch (saveError) {
      log.error('Failed to save assistant message', { error: saveError, conversationId });
    }

    timer({ status: 'success', conversationId, tokensUsed: usage?.totalTokens });
  };
}

/**
 * Execute streaming and return response
 */
async function executeStreaming(params: {
  messages: UIMessage[];
  modelConfig: { provider: string; model_id: string };
  userId: number;
  sessionId: string;
  conversationId: string;
  conversationIdValue?: string;
  conversationTitle: string;
  enabledTools: string[];
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  responseMode: 'standard' | 'flex' | 'priority';
  requestId: string;
  dbModelId: number;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
}): Promise<Response> {
  const {
    messages, modelConfig, userId, sessionId, conversationId,
    conversationIdValue, conversationTitle, enabledTools,
    reasoningEffort, responseMode, requestId, dbModelId, log, timer
  } = params;

  const systemPrompt = `You are a helpful AI assistant in the Nexus interface.`;

  const streamRequest: StreamRequest = {
    messages,
    modelId: modelConfig.model_id,
    provider: modelConfig.provider,
    userId: userId.toString(),
    sessionId,
    conversationId,
    source: 'nexus',
    systemPrompt,
    enabledTools,
    options: { reasoningEffort, responseMode },
    callbacks: {
      onFinish: createOnFinishCallback({ conversationId, dbModelId, log, timer })
    }
  };

  log.info('Starting unified streaming service', {
    provider: modelConfig.provider,
    model: modelConfig.model_id,
    conversationId
  });

  const streamResponse = await unifiedStreamingService.stream(streamRequest);

  const responseHeaders: Record<string, string> = {
    'X-Request-Id': requestId,
    'X-Unified-Streaming': 'true',
    'X-Supports-Reasoning': streamResponse.capabilities.supportsReasoning.toString()
  };

  if (!conversationIdValue && conversationId) {
    responseHeaders['X-Conversation-Id'] = conversationId;
    responseHeaders['X-Conversation-Title'] = encodeURIComponent(conversationTitle || 'New Conversation');
  }

  return streamResponse.result.toUIMessageStreamResponse({ headers: responseHeaders });
}

// Flexible message validation that accepts various formats from the UI
const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.any()).optional(),
    content: z.any().optional(),
    metadata: z.any().optional(),
  })),
  modelId: z.string(),
  provider: z.string().optional(),
  conversationId: z.string().nullable().optional(),
  enabledTools: z.array(z.string()).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  responseMode: z.enum(['standard', 'priority', 'flex']).optional()
});

/**
 * Handle image generation models
 */
async function handleImageGeneration(params: {
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  modelConfig: { provider: string; model_id: string };
  modelId: string;
  dbModelId: number;
  userId: number;
  existingConversationId?: string;
  requestId: string;
  timer: (data: Record<string, unknown>) => void;
  log: ReturnType<typeof createLogger>;
}): Promise<Response> {
  const {
    messages, modelConfig, modelId, dbModelId, userId,
    existingConversationId, requestId, timer, log
  } = params;

  log.info('Image generation model detected - using direct API call');

  // Extract and validate prompt
  const imagePrompt = extractImagePrompt(messages);
  const validation = validateImagePrompt(imagePrompt);
  if (!validation.valid && validation.error) {
    return validation.error;
  }

  // Determine provider and create/get conversation
  const imageProvider = modelConfig.provider === 'google' ? 'google' : 'openai';
  const convResult = await getOrCreateImageConversation({
    existingConversationId,
    imagePrompt,
    imageProvider,
    modelId,
    userId
  });

  if ('error' in convResult) {
    return convResult.error;
  }

  const { conversationId, title: conversationTitle } = convResult;

  // Save user message
  await saveImageUserMessage({ conversationId, imagePrompt, dbModelId });

  try {
    // Extract reference images from message
    const lastMessage = messages[messages.length - 1];
    let referenceImages = await extractReferenceImages(lastMessage);

    // If no reference images and existing conversation, check previous messages
    if (existingConversationId && referenceImages.length === 0) {
      referenceImages = await getPreviousGeneratedImages(existingConversationId);
    }

    log.info('Image generation - extracted reference images', {
      referenceImageCount: referenceImages.length
    });

    // Generate the image
    const { generateImageForNexus } = await import('@/lib/ai/image-generation-service');

    log.info('Starting image generation', {
      provider: imageProvider,
      modelId: modelConfig.model_id,
      promptLength: imagePrompt.length,
      referenceImageCount: referenceImages.length
    });

    const imageResult = await generateImageForNexus({
      prompt: imagePrompt,
      modelId: modelConfig.model_id,
      provider: imageProvider as 'openai' | 'google',
      conversationId,
      userId: userId.toString(),
      size: '1024x1024',
      quality: 'standard',
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined
    });

    // Save assistant message and update stats
    await saveImageAssistantMessage({ conversationId, imageResult, dbModelId });
    await updateImageConversationStats(conversationId);

    timer({ status: 'success', conversationId });

    return createImageStreamResponse({
      imageResult,
      conversationId,
      conversationTitle,
      isNewConversation: !existingConversationId,
      requestId
    });

  } catch (imageError) {
    return handleImageGenerationError(imageError, conversationId, requestId);
  }
}

type ValidationResult = {
  valid: true;
  data: z.infer<typeof ChatRequestSchema>;
} | {
  valid: false;
  error: Response;
};

/**
 * Validate request and return parsed data or error response
 */
function validateRequest(body: unknown, requestId: string, log: ReturnType<typeof createLogger>): ValidationResult {
  const result = ChatRequestSchema.safeParse(body);
  if (!result.success) {
    log.warn('Invalid request format', {
      errors: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
    return {
      valid: false,
      error: new Response(
        JSON.stringify({ error: 'Invalid request format', details: result.error.issues, requestId }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate conversation ID format
 */
function validateConversationId(id: string | undefined, requestId: string, log: ReturnType<typeof createLogger>): Response | null {
  if (!id) return null;

  const uuidValidation = z.string().uuid().safeParse(id);
  if (!uuidValidation.success) {
    log.warn('Invalid conversation ID format', { conversationId: id });
    return new Response(
      JSON.stringify({ error: 'Invalid conversation ID format', details: 'Conversation ID must be a valid UUID', requestId }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}

/**
 * Authenticate user and return user ID or error response
 */
async function authenticateUser(
  log: ReturnType<typeof createLogger>,
  timer: (data: Record<string, unknown>) => void
): Promise<{ userId: number; session: { sub: string } } | { error: Response }> {
  const session = await getServerSession();
  if (!session) {
    log.warn('Unauthorized request - no session');
    timer({ status: 'error', reason: 'unauthorized' });
    return { error: new Response('Unauthorized', { status: 401 }) };
  }

  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.error('Failed to get current user');
    return { error: new Response('Unauthorized', { status: 401 }) };
  }

  return { userId: currentUser.data.user.id, session };
}

/**
 * Get and validate model configuration
 */
async function getValidatedModelConfig(
  modelId: string,
  log: ReturnType<typeof createLogger>
): Promise<{
  modelConfig: NonNullable<Awaited<ReturnType<typeof getModelConfig>>>;
  dbModelId: number;
  isImageGenerationModel: boolean;
} | { error: Response }> {
  const modelConfig = await getModelConfig(modelId);
  if (!modelConfig) {
    log.error('Model not found', { modelId });
    return {
      error: new Response(
        JSON.stringify({ error: 'Selected model not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const dbModelId = modelConfig.id;
  const modelWithCapabilities = await getAIModelById(dbModelId);
  const isImageGenerationModel = hasCapability(modelWithCapabilities?.capabilities, 'imageGeneration');

  return { modelConfig, dbModelId, isImageGenerationModel };
}

/**
 * Setup conversation - create new or use existing, save user message
 */
async function setupConversation(params: {
  conversationIdValue?: string;
  messages: z.infer<typeof ChatRequestSchema>['messages'];
  userId: number;
  provider: string;
  modelId: string;
  dbModelId: number;
}): Promise<{ conversationId: string; conversationTitle: string } | { error: Response }> {
  const { conversationIdValue, messages, userId, provider, modelId, dbModelId } = params;

  let conversationId = conversationIdValue || '';
  let conversationTitle = 'New Conversation';

  if (!conversationId) {
    conversationTitle = generateConversationTitle(messages as UIMessage[]);
    const convResult = await createConversation({ userId, provider, modelId, title: conversationTitle });
    if ('error' in convResult) return convResult;
    conversationId = convResult.conversationId;
  }

  // Save user message
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === 'user') {
    const { content, parts } = extractUserContent(lastMessage as UIMessage);
    await saveUserMessage({ conversationId, content, parts, dbModelId });
  }

  return { conversationId, conversationTitle };
}

/**
 * Nexus Chat API - Native Streaming with AI SDK v5
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.nexus.chat');
  const log = createLogger({ requestId, route: 'api.nexus.chat' });

  log.info('POST /api/nexus/chat - Processing chat request with native streaming');

  try {
    // 1. Parse and validate request
    const body = await req.json();
    const validation = validateRequest(body, requestId, log);
    if (!validation.valid) return validation.error;

    const { messages, modelId, provider = 'openai', conversationId: existingConversationId, enabledTools = [] } = validation.data;
    const conversationIdValue = existingConversationId || undefined;

    // 2. Validate conversation ID format
    const convIdError = validateConversationId(conversationIdValue, requestId, log);
    if (convIdError) return convIdError;

    log.info('Request parsed', sanitizeForLogging({ messageCount: messages.length, modelId, provider, hasConversationId: !!conversationIdValue, enabledTools }));

    // 3. Authenticate user
    const authResult = await authenticateUser(log, timer);
    if ('error' in authResult) return authResult.error;
    const { userId, session } = authResult;

    // 4. Get model configuration
    const modelResult = await getValidatedModelConfig(modelId, log);
    if ('error' in modelResult) return modelResult.error;
    const { modelConfig, dbModelId, isImageGenerationModel } = modelResult;

    log.info('Model configured', sanitizeForLogging({ provider: modelConfig.provider, modelId: modelConfig.model_id, dbId: dbModelId, isImageGeneration: isImageGenerationModel }));

    // 5. Handle image generation models separately
    if (isImageGenerationModel) {
      return handleImageGeneration({
        messages, modelConfig, modelId, dbModelId, userId,
        existingConversationId: conversationIdValue, requestId, timer, log
      });
    }

    // 6. Setup conversation and save user message
    const convSetup = await setupConversation({
      conversationIdValue, messages, userId, provider, modelId, dbModelId
    });
    if ('error' in convSetup) return convSetup.error;
    const { conversationId, conversationTitle } = convSetup;

    // 7. Convert messages and process attachments
    const messagesWithParts = convertMessagesToPartsFormat(messages as UIMessage[]);
    const { lightweightMessages } = await processMessagesWithAttachments(
      conversationId,
      messagesWithParts
    );

    // 9. Execute streaming and return response
    return executeStreaming({
      messages: lightweightMessages as UIMessage[],
      modelConfig,
      userId,
      sessionId: session.sub,
      conversationId,
      conversationIdValue,
      conversationTitle,
      enabledTools,
      reasoningEffort: validation.data.reasoningEffort || 'medium',
      responseMode: validation.data.responseMode || 'standard',
      requestId,
      dbModelId,
      log,
      timer
    });

  } catch (error) {
    log.error('Nexus chat API error', {
      error: error instanceof Error ? { message: error.message, name: error.name } : String(error)
    });

    timer({ status: 'error' });

    if (error instanceof ContentSafetyBlockedError) {
      return new Response(
        JSON.stringify({ error: error.message, code: 'CONTENT_BLOCKED', requestId }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Failed to process chat request', requestId }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
    );
  }
}
