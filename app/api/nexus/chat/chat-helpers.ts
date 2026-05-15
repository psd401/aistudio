/**
 * Chat Helpers for Nexus Chat Route
 * Extracted from route.ts to reduce complexity
 */
import { UIMessage } from 'ai';
import { sql, eq } from 'drizzle-orm';
import { executeQuery, executeTransaction } from '@/lib/db/drizzle-client';
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
  // toCreateMessage converts image attachments to type:"file" parts with a url property.
  // Detect these by checking mediaType or the data URL prefix so they are saved to the DB.
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
  // AI SDK v6 UIMessage tool-part fields — required by convertToModelMessages to emit tool_result blocks
  state?: 'input-available' | 'output-available' | 'output-error';
  input?: Record<string, unknown>;
};

/** Tool call data for a single streaming step */
export type StepToolCallData = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

/** A single resolved streaming step, used for per-step message persistence */
export type StepData = {
  text: string;
  toolCalls: StepToolCallData[];
  finishReason: string;
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
      // null when extraction missed the result (e.g. stream error before onFinish).
      // UI tool components handle null with loading/fallback states — verified in
      // web-search-ui.tsx, code-interpreter-ui.tsx, chart-visualization-ui.tsx.
      const hasResult = tc.result != null;
      parts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: decodedArgs,
        argsText: JSON.stringify(decodedArgs),
        result: tc.result ?? null,
        isError: false,
        // AI SDK v6 UIMessage schema fields required by convertToModelMessages to emit
        // paired tool_result blocks when this conversation is reloaded and replayed.
        // Without state+input, convertToModelMessages emits tool_use without tool_result,
        // causing AI_MissingToolResultsError on follow-up messages. (Issue #977)
        state: hasResult ? 'output-available' : 'input-available',
        input: decodedArgs,
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

/**
 * Persist a multi-step tool-use response as separate per-step messages.
 *
 * When maxSteps > 1, the AI SDK runs an agentic loop where each step may
 * produce tool calls. Consolidating all steps into one assistant message
 * breaks conversation replay: convertToModelMessages cannot reconstruct
 * the correct multi-turn (assistant→user→assistant) structure needed by
 * Anthropic. Saving each step separately preserves that structure.
 *
 * Stats (messageCount, totalTokens) are updated once after all rows are
 * inserted to avoid double-counting.
 */
export async function saveConversationSteps(params: {
  conversationId: string;
  steps: StepData[];
  dbModelId: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
}): Promise<void> {
  const { conversationId, steps, dbModelId, usage, finishReason } = params;

  // Build all row data before opening a transaction (pure computation)
  type RowData = {
    sanitizedContent: string;
    parts: AssistantPart[];
    stepFinishReason: string;
    stepIndex: number;
    hasToolCalls: boolean;
    toolCallCount: number;
    hasText: boolean;
    isLastStep: boolean;
  };

  const rowsToInsert: RowData[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLastStep = i === steps.length - 1;
    const stepFinishReason = isLastStep ? (finishReason ?? 'stop') : step.finishReason;
    const hasToolCalls = step.toolCalls.length > 0;
    const hasText = step.text.length > 0;
    if (!hasToolCalls && !hasText) continue;
    const sanitizedContent = step.text ? sanitizeTextForDatabase(step.text) : '';
    const parts = buildAssistantParts(sanitizedContent, hasToolCalls ? step.toolCalls : undefined);
    rowsToInsert.push({ sanitizedContent, parts, stepFinishReason, stepIndex: i, hasToolCalls, toolCallCount: step.toolCalls.length, hasText, isLastStep });
  }

  if (rowsToInsert.length === 0) {
    log.warn('No step messages had content to save', { conversationId });
    return;
  }

  const savedCount = rowsToInsert.length;
  // Base timestamp for this batch. Each step row gets createdAt = baseTime + stepIndex
  // milliseconds so that ORDER BY created_at always returns steps in the correct
  // agentic sequence. All rows sharing the same timestamp would produce a
  // nondeterministic read order and break multi-turn replay. (Issue #977)
  const baseTime = new Date();

  // All inserts + stats update in a single transaction to prevent partial writes
  await executeTransaction(async (tx) => {
    for (const row of rowsToInsert) {
      const createdAt = new Date(baseTime.getTime() + row.stepIndex);
      await tx.insert(nexusMessages).values({
        conversationId,
        role: 'assistant',
        content: row.sanitizedContent,
        parts: sql`${safeJsonbStringify(row.parts)}::jsonb`,
        modelId: dbModelId,
        // Token usage not available per-step; real totals are aggregated at the
        // conversation level in the stats update below.
        tokenUsage: sql`${safeJsonbStringify({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })}::jsonb`,
        finishReason: row.stepFinishReason,
        metadata: sql`${safeJsonbStringify({})}::jsonb`,
        createdAt,
        updatedAt: baseTime,
      });
    }
    await tx.update(nexusConversations)
      .set({
        messageCount: sql`${nexusConversations.messageCount} + ${savedCount}`,
        totalTokens: sql`${nexusConversations.totalTokens} + ${usage?.totalTokens ?? 0}`,
        lastMessageAt: new Date(baseTime.getTime() + (rowsToInsert[rowsToInsert.length - 1]?.stepIndex ?? 0)),
        updatedAt: baseTime,
      })
      .where(eq(nexusConversations.id, conversationId));
  }, 'saveConversationSteps');

  for (const row of rowsToInsert) {
    log.info('Saved step message', {
      conversationId,
      stepIndex: row.stepIndex,
      isLastStep: row.isLastStep,
      hasToolCalls: row.hasToolCalls,
      toolCallCount: row.toolCallCount,
      hasText: row.hasText,
    });
  }

  log.info('Multi-step response saved', {
    conversationId,
    stepCount: steps.length,
    savedCount,
    totalTokens: usage?.totalTokens,
  });
}
