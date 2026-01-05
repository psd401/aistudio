import { UIMessage } from 'ai';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getAIModelById } from '@/lib/db/drizzle';
import { executeQuery } from '@/lib/db/drizzle-client';
import { hasCapability } from '@/lib/ai/capability-utils';
import { eq, sql } from 'drizzle-orm';
import { nexusConversations, nexusMessages } from '@/lib/db/schema';
import { processMessagesWithAttachments } from '@/lib/services/attachment-storage-service';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import type { StreamRequest } from '@/lib/streaming/types';
import { getModelConfig } from '@/lib/ai/model-config';
import { sanitizeTextForDatabase } from '@/lib/utils/text-sanitizer';

// Allow streaming responses up to 5 minutes for long-running conversations
export const maxDuration = 300;

// Flexible message validation that accepts various formats from the UI
// We use z.any() here for the message array because the actual UIMessage type
// is complex with generics and we validate the critical fields (role, id) at runtime
const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    role: z.enum(['system', 'user', 'assistant']),
    // Allow flexible content/parts format - validated at runtime
    parts: z.array(z.any()).optional(),
    content: z.any().optional(),
    metadata: z.any().optional(),
  })),
  modelId: z.string(),
  provider: z.string().optional(),
  conversationId: z.string().nullable().optional(), // Accept null, undefined, or string
  enabledTools: z.array(z.string()).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  responseMode: z.enum(['standard', 'priority', 'flex']).optional()
});

/**
 * Nexus Chat API - Native Streaming with AI SDK v5
 * Migrated from polling architecture to direct streaming for better performance
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.nexus.chat');
  const log = createLogger({ requestId, route: 'api.nexus.chat' });

  log.info('POST /api/nexus/chat - Processing chat request with native streaming');

  try {
    // 1. Parse and validate request with Zod schema
    const body = await req.json();

    const validationResult = ChatRequestSchema.safeParse(body);
    if (!validationResult.success) {
      log.warn('Invalid request format', {
        errors: validationResult.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
      return new Response(
        JSON.stringify({
          error: 'Invalid request format',
          details: validationResult.error.issues,
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Extract validated fields
    const {
      messages,
      modelId,
      provider = 'openai',
      conversationId: existingConversationId,
      enabledTools = []
    } = validationResult.data;

    // Handle null conversationId (treat as undefined for new conversations)
    const conversationIdValue = existingConversationId || undefined;

    // Validate conversationId format if provided (must be valid UUID for database operations)
    if (conversationIdValue) {
      const uuidSchema = z.string().uuid();
      const uuidValidation = uuidSchema.safeParse(conversationIdValue);
      if (!uuidValidation.success) {
        log.warn('Invalid conversation ID format', { conversationId: conversationIdValue });
        return new Response(
          JSON.stringify({
            error: 'Invalid conversation ID format',
            details: 'Conversation ID must be a valid UUID',
            requestId
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    log.info('Request parsed', sanitizeForLogging({
      messageCount: messages.length,
      modelId,
      provider,
      hasConversationId: !!conversationIdValue,
      enabledTools
    }));

    // 2. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }

    log.debug('User authenticated', sanitizeForLogging({ userId: session.sub }));

    // 3. Get current user
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = currentUser.data.user.id;

    // 4. Get model configuration using shared helper (ensures proper field mapping)
    const modelConfig = await getModelConfig(modelId);

    if (!modelConfig) {
      log.error('Model not found', { modelId });
      return new Response(
        JSON.stringify({ error: 'Selected model not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const dbModelId = modelConfig.id;

    // Check if this is an image generation model
    // Query model capabilities to check for image generation
    const modelWithCapabilities = await getAIModelById(dbModelId);

    const isImageGenerationModel = hasCapability(modelWithCapabilities?.capabilities, 'imageGeneration');

    // Note: getModelConfig already filters by nexus_enabled=true, so if we got a model, it's Nexus-enabled
    // Image generation models are handled separately below

    log.info('Model configured', sanitizeForLogging({
      provider: modelConfig.provider,
      modelId: modelConfig.model_id,
      dbId: dbModelId,
      isImageGeneration: isImageGenerationModel,
      modelIdType: typeof modelConfig.model_id,
      providerType: typeof modelConfig.provider
    }));

    // 5. Handle image generation models separately (not via streaming)
    if (isImageGenerationModel) {
      log.info('Image generation model detected - using direct API call');

      // Extract prompt from the last user message
      const lastMessage = messages[messages.length - 1];
      let imagePrompt = '';

      if (lastMessage && lastMessage.role === 'user') {
        const messageContent = (lastMessage as UIMessage & {
          content?: string | Array<{ type: string; text?: string }>
        }).content;

        if (typeof messageContent === 'string') {
          imagePrompt = messageContent.trim();
        } else if (Array.isArray(messageContent)) {
          const textPart = messageContent.find(part => part.type === 'text' && part.text);
          imagePrompt = (textPart?.text || '').trim();
        } else if (lastMessage.parts && Array.isArray(lastMessage.parts)) {
          const textPart = lastMessage.parts.find((part: { type: string; text?: string }) => part.type === 'text' && part.text) as { type: string; text: string } | undefined;
          imagePrompt = (textPart?.text || '').trim();
        }
      }

      // Validate prompt
      if (imagePrompt.length === 0) {
        return new Response(
          JSON.stringify({ error: 'Image generation requires a text prompt' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (imagePrompt.length > 4000) {
        return new Response(
          JSON.stringify({
            error: 'Image prompt is too long. Maximum 4000 characters allowed.',
            maxLength: 4000,
            currentLength: imagePrompt.length
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Content policy validation
      const lowercasePrompt = imagePrompt.toLowerCase();
      const forbiddenPatterns = [
        'nude', 'naked', 'nsfw', 'explicit', 'sexual', 'porn', 'erotic',
        'violence', 'blood', 'gore', 'weapon', 'harm', 'kill', 'death',
        'hate', 'racist', 'discriminatory', 'offensive'
      ];

      if (forbiddenPatterns.some(pattern => lowercasePrompt.includes(pattern))) {
        return new Response(
          JSON.stringify({
            error: 'Image prompt violates content policy. Please revise your request.'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // TODO: Implement actual image generation
      // This would call the OpenAI DALL-E API or equivalent
      // For now, return error indicating feature not yet implemented in streaming mode
      return new Response(
        JSON.stringify({
          error: 'Image generation via streaming is not yet implemented. Please use the legacy endpoint.',
          suggestion: 'Image generation support will be added in a future update.'
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 6. Handle conversation (create new or use existing)
    let conversationId: string = conversationIdValue || '';
    let conversationTitle = 'New Conversation';

    if (!conversationId) {
      // Generate a title from the first user message
      const firstUserMessage = messages.find(m => m.role === 'user');
      if (firstUserMessage) {
        // Extract text content for title generation
        let messageText = '';

        // Handle both legacy content format and new parts format
        const messageWithContent = firstUserMessage as UIMessage & {
          content?: string | Array<{ type: string; text?: string }>;
          parts?: Array<{ type: string; text?: string; [key: string]: unknown }>;
        };

        // Check if message has parts (new format)
        if (messageWithContent.parts && Array.isArray(messageWithContent.parts)) {
          const textPart = messageWithContent.parts.find((part): part is { type: 'text'; text: string } =>
            part.type === 'text' && typeof (part as Record<string, unknown>).text === 'string'
          );
          if (textPart?.text) {
            messageText = textPart.text;
          }
        }
        // Fallback to legacy content format
        else if (messageWithContent.content) {
          if (typeof messageWithContent.content === 'string') {
            messageText = messageWithContent.content;
          } else if (Array.isArray(messageWithContent.content)) {
            const textPart = messageWithContent.content.find(part => part.type === 'text' && part.text);
            if (textPart?.text) {
              messageText = textPart.text;
            }
          }
        }

        // Generate a concise title (max 40 chars)
        if (messageText) {
          // Remove newlines and extra whitespace for header compatibility
          const cleanedText = messageText.replace(/\s+/g, ' ').trim();
          conversationTitle = cleanedText.slice(0, 40).trim();
          if (cleanedText.length > 40) {
            conversationTitle += '...';
          }
        }
      }

      // Sanitize conversation title to remove null bytes and invalid UTF-8 sequences
      const sanitizedTitle = sanitizeTextForDatabase(conversationTitle);

      // Create new Nexus conversation with generated title
      const now = new Date();
      const createResult = await executeQuery(
        (db) => db.insert(nexusConversations)
          .values({
            userId,
            provider,
            modelUsed: modelId,
            title: sanitizedTitle,
            messageCount: 0,
            totalTokens: 0,
            metadata: sql`${JSON.stringify({ source: 'nexus', streaming: true })}::jsonb`,
            createdAt: now,
            updatedAt: now
          })
          .returning({ id: nexusConversations.id }),
        'createNexusConversation'
      );

      // Validate conversation creation result
      if (!createResult || createResult.length === 0 || !createResult[0]?.id) {
        log.error('Failed to create conversation - no ID returned', {
          resultLength: createResult?.length,
          result: createResult
        });
        return new Response(
          JSON.stringify({
            error: 'Failed to create conversation',
            requestId
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      conversationId = createResult[0].id as string;

      log.info('Created new Nexus conversation', sanitizeForLogging({
        conversationId,
        userId,
        title: conversationTitle
      }));
    }

    // 7. Save user message to nexus_messages
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
      // Extract text content from message
      let userContent = '';
      let serializableParts: unknown[] = [];

      // Handle both legacy content format and new parts format
      const messageWithContent = lastMessage as UIMessage & {
        content?: string | Array<{ type: string; text?: string; image?: string }>;
        parts?: Array<{ type: string; text?: string; image?: string; [key: string]: unknown }>;
      };

      // Check if message has parts (new format)
      if (messageWithContent.parts && Array.isArray(messageWithContent.parts)) {
        for (const part of messageWithContent.parts) {
          const typedPart = part as Record<string, unknown>;
          if (part.type === 'text' && typeof typedPart.text === 'string') {
            // Sanitize text before adding to arrays to prevent JSONB parse errors
            const sanitizedText = sanitizeTextForDatabase(typedPart.text);
            userContent += (userContent ? ' ' : '') + sanitizedText;
            serializableParts.push({ type: 'text', text: sanitizedText });
          } else if (typedPart.type === 'image' && typedPart.image) {
            // Store only boolean flag - no image data or prefixes
            serializableParts.push({
              type: 'image',
              metadata: {
                hasImage: true
              }
            });
          }
        }
      }
      // Fallback to legacy content format
      else if (messageWithContent.content) {
        if (typeof messageWithContent.content === 'string') {
          // Sanitize text before adding to arrays to prevent JSONB parse errors
          const sanitizedText = sanitizeTextForDatabase(messageWithContent.content);
          userContent = sanitizedText;
          serializableParts = [{ type: 'text', text: sanitizedText }];
        } else if (Array.isArray(messageWithContent.content)) {
          for (const part of messageWithContent.content) {
            if (part.type === 'text' && part.text) {
              // Sanitize text before adding to arrays to prevent JSONB parse errors
              const sanitizedText = sanitizeTextForDatabase(part.text);
              userContent += (userContent ? ' ' : '') + sanitizedText;
              serializableParts.push({ type: 'text', text: sanitizedText });
            } else if (part.type === 'image' && part.image) {
              serializableParts.push({
                type: 'image',
                metadata: {
                  hasImage: true
                }
              });
            }
          }
        }
      }

      // Note: userContent and serializableParts already contain sanitized text
      // Sanitization happens when extracting text from message parts above

      await executeQuery(
        (db) => db.insert(nexusMessages)
          .values({
            conversationId,
            role: 'user',
            content: userContent || '',
            parts: sql`${JSON.stringify(serializableParts)}::jsonb`,
            modelId: dbModelId,
            metadata: sql`${JSON.stringify({})}::jsonb`,
            createdAt: new Date()
          }),
        'saveUserMessage'
      );

      // Update conversation's last_message_at and message_count
      await executeQuery(
        (db) => db.update(nexusConversations)
          .set({
            lastMessageAt: new Date(),
            messageCount: sql`${nexusConversations.messageCount} + 1`,
            updatedAt: new Date()
          })
          .where(eq(nexusConversations.id, conversationId)),
        'updateConversationAfterUserMessage'
      );

      log.debug('User message saved to nexus_messages');
    }

    // 8. Tools will be created by UnifiedStreamingService from enabledTools

    // 9. Build system prompt (optional, can add Nexus-specific context here)
    const systemPrompt = `You are a helpful AI assistant in the Nexus interface.`;

    // 10. Convert messages to AI SDK v5 format (parts array) before processing attachments
    const messagesWithParts = messages.map(message => {
      // If message already has parts, use as-is
      if (message.parts) {
        return message;
      }

      // Convert legacy content format to parts format
      const messageContent = (message as UIMessage & {
        content?: string | Array<{ type: string; text?: string; image?: string }>
      }).content;

      if (typeof messageContent === 'string') {
        return {
          ...message,
          parts: [{ type: 'text', text: messageContent }]
        };
      } else if (Array.isArray(messageContent)) {
        return {
          ...message,
          parts: messageContent
        };
      } else {
        return {
          ...message,
          parts: []
        };
      }
    });

    // 11. Process messages to store attachments in S3 and create lightweight versions
    const { lightweightMessages } = await processMessagesWithAttachments(
      conversationId,
      messagesWithParts as UIMessage[]
    );

    // 12. Use unified streaming service (same as /api/chat)
    log.info('Starting unified streaming service', {
      provider: modelConfig.provider,
      model: modelConfig.model_id,
      conversationId
    });

    // Add debug logging before streaming
    log.info('StreamRequest validation', {
      hasModelId: !!modelConfig.model_id,
      modelIdType: typeof modelConfig.model_id,
      modelIdValue: modelConfig.model_id,
      hasProvider: !!modelConfig.provider,
      providerValue: modelConfig.provider,
      hasMessages: !!lightweightMessages,
      messageCount: lightweightMessages?.length
    });

    // Create streaming request with callbacks
    const streamRequest: StreamRequest = {
      messages: lightweightMessages as UIMessage[],
      modelId: modelConfig.model_id, // getModelConfig returns proper string type
      provider: modelConfig.provider, // getModelConfig returns proper string type
      userId: userId.toString(),
      sessionId: session.sub,
      conversationId,
      source: 'nexus',
      systemPrompt,
      enabledTools, // Pass enabledTools - UnifiedStreamingService will create tools from adapter
      options: {
        reasoningEffort: validationResult.data.reasoningEffort || 'medium',
        responseMode: validationResult.data.responseMode || 'standard'
      },
      callbacks: {
        onFinish: async ({ text, usage, finishReason }) => {
          log.info('Stream finished, saving assistant message', {
            conversationId,
            hasText: !!text,
            textLength: text?.length || 0,
            hasUsage: !!usage,
            finishReason
          });

          try {
            // Save assistant message to nexus_messages
            if (!text || text.length === 0) {
              log.warn('No text content to save for assistant message');
              return;
            }

            // Sanitize assistant content to remove null bytes and invalid UTF-8 sequences
            const sanitizedAssistantContent = sanitizeTextForDatabase(text);

            const now = new Date();
            await executeQuery(
              (db) => db.insert(nexusMessages)
                .values({
                  conversationId,
                  role: 'assistant',
                  content: sanitizedAssistantContent,
                  parts: sql`${JSON.stringify([{ type: 'text', text: sanitizedAssistantContent }])}::jsonb`,
                  modelId: dbModelId,
                  tokenUsage: sql`${JSON.stringify({
                    promptTokens: usage?.promptTokens || 0,
                    completionTokens: usage?.completionTokens || 0,
                    totalTokens: usage?.totalTokens || 0
                  })}::jsonb`,
                  finishReason: finishReason || 'stop',
                  metadata: sql`${JSON.stringify({})}::jsonb`,
                  createdAt: now,
                  updatedAt: now
                }),
              'saveAssistantMessage'
            );

            // Update conversation statistics
            await executeQuery(
              (db) => db.update(nexusConversations)
                .set({
                  messageCount: sql`${nexusConversations.messageCount} + 1`,
                  totalTokens: sql`${nexusConversations.totalTokens} + ${usage?.totalTokens || 0}`,
                  lastMessageAt: new Date(),
                  updatedAt: new Date()
                })
                .where(eq(nexusConversations.id, conversationId)),
              'updateConversationAfterAssistantMessage'
            );

            log.info('Assistant message saved successfully', {
              conversationId,
              textLength: text.length,
              totalTokens: usage?.totalTokens
            });
          } catch (saveError) {
            log.error('Failed to save assistant message', {
              error: saveError,
              conversationId,
              modelId: dbModelId
            });
            // Error is logged but not thrown to avoid breaking the stream
          }

          timer({
            status: 'success',
            conversationId,
            tokensUsed: usage?.totalTokens
          });
        }
      }
    };

    const streamResponse = await unifiedStreamingService.stream(streamRequest);

    // Return unified streaming response
    log.info('Returning unified streaming response', {
      conversationId,
      requestId,
      hasConversationId: !!conversationId,
      supportsReasoning: streamResponse.capabilities.supportsReasoning
    });

    // Set response headers
    const responseHeaders: Record<string, string> = {
      'X-Request-Id': requestId,
      'X-Unified-Streaming': 'true',
      'X-Supports-Reasoning': streamResponse.capabilities.supportsReasoning.toString()
    };

    // Only send conversation ID header for new conversations
    if (!conversationIdValue && conversationId) {
      responseHeaders['X-Conversation-Id'] = conversationId;
      responseHeaders['X-Conversation-Title'] = encodeURIComponent(conversationTitle || 'New Conversation');
    }

    return streamResponse.result.toUIMessageStreamResponse({
      headers: responseHeaders
    });

  } catch (error) {
    log.error('Nexus chat API error', {
      error: error instanceof Error ? {
        message: error.message,
        name: error.name
      } : String(error)
    });

    timer({ status: 'error' });

    // Return generic error response
    return new Response(
      JSON.stringify({
        error: 'Failed to process chat request',
        requestId
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      }
    );
  }
}
