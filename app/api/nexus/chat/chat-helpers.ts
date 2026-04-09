/**
 * Chat Helpers for Nexus Chat Route
 * Extracted from route.ts to reduce complexity
 */
import { UIMessage } from 'ai';
import { sql, eq } from 'drizzle-orm';
import { executeQuery } from '@/lib/db/drizzle-client';
import { nexusConversations, nexusMessages } from '@/lib/db/schema';
import { sanitizeTextForDatabase, decodeHtmlEntitiesDeep } from '@/lib/utils/text-sanitizer';
import { safeJsonbStringify } from '@/lib/db/json-utils';
import { createLogger, sanitizeForLogging } from '@/lib/logger';

const log = createLogger({ route: 'api.nexus.chat.helpers' });

interface MessageWithContent {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content?: string | Array<{ type: string; text?: string; image?: string }>;
  parts?: Array<{ type: string; text?: string; image?: string; [key: string]: unknown }>;
}

/**
 * Extract text content from a message for title generation
 */
export function extractTextFromMessage(message: MessageWithContent): string {
  // Check if message has parts (new format)
  if (message.parts && Array.isArray(message.parts)) {
    const textPart = message.parts.find((part): part is { type: 'text'; text: string } =>
      part.type === 'text' && typeof (part as Record<string, unknown>).text === 'string'
    );
    return textPart?.text || '';
  }

  // Fallback to legacy content format
  if (message.content) {
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const textPart = message.content.find(part => part.type === 'text' && part.text);
      return textPart?.text || '';
    }
  }

  return '';
}

/**
 * Generate conversation title from first user message
 */
export function generateConversationTitle(messages: MessageWithContent[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user');
  if (!firstUserMessage) {
    return 'New Conversation';
  }

  const messageText = extractTextFromMessage(firstUserMessage);
  if (!messageText) {
    return 'New Conversation';
  }

  // Remove newlines and extra whitespace for header compatibility
  const cleanedText = messageText.replace(/\s+/g, ' ').trim();
  let title = cleanedText.slice(0, 40).trim();
  if (cleanedText.length > 40) {
    title += '...';
  }
  return title;
}

/**
 * Create new conversation in database
 */
export async function createConversation(params: {
  userId: number;
  provider: string;
  modelId: string;
  title: string;
}): Promise<{ conversationId: string } | { error: Response; requestId?: string }> {
  const { userId, provider, modelId, title } = params;

  const sanitizedTitle = sanitizeTextForDatabase(title);
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
        metadata: sql`${safeJsonbStringify({ source: 'nexus', streaming: true })}::jsonb`,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: nexusConversations.id }),
    'createNexusConversation'
  );

  if (!createResult || createResult.length === 0 || !createResult[0]?.id) {
    log.error('Failed to create conversation - no ID returned', {
      resultLength: createResult?.length,
      result: createResult
    });
    return {
      error: new Response(
        JSON.stringify({ error: 'Failed to create conversation' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const conversationId = createResult[0].id as string;
  log.info('Created new Nexus conversation', sanitizeForLogging({ conversationId, userId, title }));

  return { conversationId };
}

/**
 * Process a single part from message parts array
 */
function processMessagePart(
  part: { type: string; text?: string; image?: string; [key: string]: unknown }
): { content: string; serialized: unknown } | null {
  const typedPart = part as Record<string, unknown>;
  if (part.type === 'text' && typeof typedPart.text === 'string') {
    const sanitizedText = sanitizeTextForDatabase(typedPart.text);
    return { content: sanitizedText, serialized: { type: 'text', text: sanitizedText } };
  }
  if (typedPart.type === 'image' && typedPart.image) {
    return { content: '', serialized: { type: 'image', metadata: { hasImage: true } } };
  }
  return null;
}

/**
 * Extract user content and parts from message
 */
export function extractUserContent(message: MessageWithContent): {
  content: string;
  parts: unknown[];
} {
  const contentParts: string[] = [];
  const serializableParts: unknown[] = [];

  // Check if message has parts (new format)
  if (message.parts && Array.isArray(message.parts)) {
    for (const part of message.parts) {
      const result = processMessagePart(part);
      if (result) {
        if (result.content) contentParts.push(result.content);
        serializableParts.push(result.serialized);
      }
    }
  } else if (typeof message.content === 'string') {
    const sanitizedText = sanitizeTextForDatabase(message.content);
    contentParts.push(sanitizedText);
    serializableParts.push({ type: 'text', text: sanitizedText });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const result = processMessagePart(part);
      if (result) {
        if (result.content) contentParts.push(result.content);
        serializableParts.push(result.serialized);
      }
    }
  }

  return { content: contentParts.join(' '), parts: serializableParts };
}

/**
 * Save user message to database.
 *
 * Note: Unlike saveAssistantMessage(), this function does NOT guard against
 * empty content because extractUserContent() only serializes text/image parts.
 * Attachment-only messages (PDF, DOCX, etc.) arrive with content='' and parts=[]
 * since processMessagePart() doesn't handle file types — but the user DID send
 * something. The caller (setupConversation) validates the original message.
 */
export async function saveUserMessage(params: {
  conversationId: string;
  content: string;
  parts: unknown[];
  dbModelId: number;
}): Promise<void> {
  const { conversationId, content, parts, dbModelId } = params;

  await executeQuery(
    (db) => db.insert(nexusMessages)
      .values({
        conversationId,
        role: 'user',
        content: content || '',
        parts: parts.length > 0 ? sql`${safeJsonbStringify(parts)}::jsonb` : null,
        modelId: dbModelId,
        metadata: sql`${safeJsonbStringify({})}::jsonb`,
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

/**
 * Convert messages to parts format for AI SDK v5
 */
export function convertMessagesToPartsFormat(messages: MessageWithContent[]): UIMessage[] {
  return messages.map(message => {
    // If message already has parts, use as-is
    if (message.parts) {
      return message as unknown as UIMessage;
    }

    // Convert legacy content format to parts format
    if (typeof message.content === 'string') {
      return {
        ...message,
        parts: [{ type: 'text', text: message.content }]
      } as unknown as UIMessage;
    }

    if (Array.isArray(message.content)) {
      return {
        ...message,
        parts: message.content
      } as unknown as UIMessage;
    }

    return {
      ...message,
      parts: []
    } as unknown as UIMessage;
  });
}

type ToolCallData = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

type AssistantPart = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
};

/**
 * Build assistant message parts from text and tool calls
 */
function buildAssistantParts(
  sanitizedContent: string,
  toolCalls?: ToolCallData[]
): AssistantPart[] {
  const parts: AssistantPart[] = [];

  if (sanitizedContent) {
    parts.push({ type: 'text', text: sanitizedContent });
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      // Decode HTML entities in args to prevent argsText mismatch on conversation reload.
      // AI models may generate HTML-encoded characters (e.g., &amp; for &) in tool args,
      // which causes assistant-ui's append-only argsText check to fail when the conversation
      // is reloaded and argsText is recomputed from the parsed args object. (Issue #798)
      const decodedArgs = decodeHtmlEntitiesDeep(tc.args) as Record<string, unknown>;
      parts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: decodedArgs,
        argsText: JSON.stringify(decodedArgs),
        // null when extraction missed the result (e.g. stream error before onFinish).
        // UI tool components handle null with loading/fallback states — verified in
        // web-search-ui.tsx, code-interpreter-ui.tsx, chart-visualization-ui.tsx.
        result: tc.result ?? null,
        isError: false,
      });
    }
  }

  return parts;
}

/**
 * Check if message has content to save
 */
function hasMessageContent(text: string, toolCalls?: ToolCallData[]): boolean {
  return (text && text.length > 0) || (toolCalls !== undefined && toolCalls.length > 0);
}

/**
 * Build token usage object with defaults
 */
function buildTokenUsage(usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) {
  return {
    promptTokens: usage?.promptTokens || 0,
    completionTokens: usage?.completionTokens || 0,
    totalTokens: usage?.totalTokens || 0
  };
}

/**
 * Save assistant message and update conversation stats
 */
export async function saveAssistantMessage(params: {
  conversationId: string;
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
  toolCalls?: ToolCallData[];
  dbModelId: number;
}): Promise<void> {
  const { conversationId, text, usage, finishReason, toolCalls, dbModelId } = params;

  if (!hasMessageContent(text, toolCalls)) {
    log.warn('No text or tool calls to save for assistant message');
    return;
  }

  const sanitizedContent = text ? sanitizeTextForDatabase(text) : '';
  const assistantParts = buildAssistantParts(sanitizedContent, toolCalls);
  const tokenUsage = buildTokenUsage(usage);

  if (toolCalls && toolCalls.length > 0) {
    log.info('Including tool calls in assistant message', {
      conversationId,
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map(tc => tc.toolName)
    });
  }

  const now = new Date();
  await executeQuery(
    (db) => db.insert(nexusMessages)
      .values({
        conversationId,
        role: 'assistant',
        content: sanitizedContent,
        parts: sql`${safeJsonbStringify(assistantParts)}::jsonb`,
        modelId: dbModelId,
        tokenUsage: sql`${safeJsonbStringify(tokenUsage)}::jsonb`,
        finishReason: finishReason || 'stop',
        metadata: sql`${safeJsonbStringify({})}::jsonb`,
        createdAt: now,
        updatedAt: now
      }),
    'saveAssistantMessage'
  );

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
}


