/**
 * Decision Chat API Route
 *
 * Streaming chat endpoint for decision capture from meeting transcripts.
 * Uses a dedicated model (DECISION_CAPTURE_MODEL setting) and decision-specific
 * tools for extracting, validating, and committing decisions to the context graph.
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */

import { UIMessage } from 'ai';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getModelConfig } from '@/lib/ai/model-config';
import { processMessagesWithAttachments } from '@/lib/services/attachment-storage-service';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import type { StreamRequest } from '@/lib/streaming/types';
import { ContentSafetyBlockedError } from '@/lib/streaming/types';
import { getDecisionFrameworkPrompt } from '@/lib/graph/decision-framework';
import { getRequiredSetting } from '@/lib/settings-manager';
import { createDecisionCaptureTools } from '@/lib/tools/decision-capture-tools';
import { hasToolAccess } from '@/utils/roles';

import {
  generateConversationTitle,
  createConversation,
  extractUserContent,
  saveUserMessage,
  convertMessagesToPartsFormat,
  saveAssistantMessage,
} from '../chat/chat-helpers';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

// ============================================================================
// Request Validation Schema
// ============================================================================

// Message part schemas matching AI SDK v6 UIMessagePart types
const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  state: z.enum(['streaming', 'done']).optional(),
}).passthrough();

const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  state: z.enum(['streaming', 'done']).optional(),
}).passthrough();

const FilePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string(),
  url: z.string(),
}).passthrough();

const ToolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
}).passthrough();

const StepStartPartSchema = z.object({
  type: z.literal('step-start'),
}).passthrough();

const SourceUrlPartSchema = z.object({
  type: z.literal('source-url'),
}).passthrough();

const SourceDocumentPartSchema = z.object({
  type: z.literal('source-document'),
}).passthrough();

// Union of all known part types, with passthrough for forward compatibility
const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ReasoningPartSchema,
  FilePartSchema,
  ToolCallPartSchema,
  StepStartPartSchema,
  SourceUrlPartSchema,
  SourceDocumentPartSchema,
]);

const DecisionChatRequestSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(MessagePartSchema).optional(),
    content: z.union([z.string(), z.array(MessagePartSchema)]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })),
  conversationId: z.string().nullable().optional(),
});

// ============================================================================
// Helper Functions (following pattern from chat/route.ts)
// ============================================================================

type ValidationResult = {
  valid: true;
  data: z.infer<typeof DecisionChatRequestSchema>;
  conversationIdValue?: string;
} | {
  valid: false;
  error: Response;
};

/**
 * Validate and parse the incoming request body
 */
function validateRequest(
  body: unknown,
  requestId: string,
  log: ReturnType<typeof createLogger>
): ValidationResult {
  const result = DecisionChatRequestSchema.safeParse(body);
  if (!result.success) {
    log.warn('Invalid request format', {
      errors: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return {
      valid: false,
      error: new Response(
        JSON.stringify({ error: 'Invalid request format', details: result.error.issues, requestId }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  const conversationIdValue = result.data.conversationId || undefined;

  // Validate conversation ID format if present
  if (conversationIdValue) {
    const uuidValidation = z.string().uuid().safeParse(conversationIdValue);
    if (!uuidValidation.success) {
      log.warn('Invalid conversation ID format', { conversationId: conversationIdValue });
      return {
        valid: false,
        error: new Response(
          JSON.stringify({ error: 'Invalid conversation ID format', requestId }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }
  }

  return { valid: true, data: result.data, conversationIdValue };
}

/**
 * Authenticate user and verify decision-capture tool access
 */
async function authenticateAndAuthorize(params: {
  requestId: string;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
}): Promise<{ userId: number; sessionId: string } | { error: Response }> {
  const { requestId, log, timer } = params;

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

  const userId = currentUser.data.user.id;

  // Defense in depth — UI layout also checks, but API must enforce independently
  const hasAccess = await hasToolAccess('decision-capture');
  if (!hasAccess) {
    log.warn('User does not have decision-capture tool access', { userId });
    timer({ status: 'error', reason: 'forbidden' });
    return {
      error: new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'You do not have permission to use the Decision Capture tool',
          requestId,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
      ),
    };
  }

  return { userId, sessionId: session.sub };
}

/**
 * Resolve the decision capture model from admin settings
 */
async function getDecisionModelConfig(params: {
  requestId: string;
  log: ReturnType<typeof createLogger>;
}): Promise<{ modelConfig: NonNullable<Awaited<ReturnType<typeof getModelConfig>>>; dbModelId: number } | { error: Response }> {
  const { requestId, log } = params;

  const modelId = await getRequiredSetting('DECISION_CAPTURE_MODEL');
  const modelConfig = await getModelConfig(modelId);
  if (!modelConfig) {
    log.error('Decision capture model not found', { modelId });
    return {
      error: new Response(
        JSON.stringify({ error: 'Decision capture model not configured or unavailable', requestId }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  log.info('Model configured', sanitizeForLogging({
    provider: modelConfig.provider,
    modelId: modelConfig.model_id,
    dbId: modelConfig.id,
  }));

  return { modelConfig, dbModelId: modelConfig.id };
}

/**
 * Create or retrieve conversation and save the user message
 */
async function setupConversation(params: {
  conversationIdValue?: string;
  messages: z.infer<typeof DecisionChatRequestSchema>['messages'];
  userId: number;
  modelId: string;
  dbModelId: number;
}): Promise<{ conversationId: string; conversationTitle: string } | { error: Response }> {
  const { conversationIdValue, messages, userId, modelId, dbModelId } = params;

  let conversationId = conversationIdValue || '';
  let conversationTitle = 'New Decision Capture';

  if (!conversationId) {
    conversationTitle = generateConversationTitle(messages as UIMessage[]);
    const convResult = await createConversation({
      userId,
      provider: 'decision-capture',
      modelId,
      title: conversationTitle,
    });
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
 * Build the decision capture system prompt
 */
async function buildSystemPrompt(): Promise<string> {
  const frameworkPrompt = await getDecisionFrameworkPrompt();

  return `${frameworkPrompt}

## Your Role: Transcript Decision Extractor

You are analyzing meeting transcripts to extract decisions. Follow these steps:

1. **Search first**: Before creating new nodes, use \`search_graph_nodes\` to check if related decisions, people, or evidence already exist in the graph.

2. **Extract decisions**: Identify each decision made in the transcript. Look for:
   - Explicit decisions ("We decided to...", "The decision was...")
   - Implicit decisions (agreements reached, options selected)
   - Rejected alternatives (these are also valuable context)

3. **Propose structured subgraphs**: For each decision, use \`propose_decision\` to create a structured proposal with nodes and edges. The completeness check will tell you what's missing.

4. **Ask follow-up questions** when the transcript is vague about:
   - Who proposed or approved the decision
   - What evidence or constraints informed it
   - Under what conditions it should be revisited
   - The reasoning behind the choice

5. **Wait for confirmation**: NEVER call \`commit_decision\` until the user explicitly confirms the proposal. Always show the proposal first and ask for approval.

When analyzing a transcript:
- Process one decision at a time
- Be thorough but concise in your proposals
- Use existing graph nodes when they match (set existingNodeId)
- Ask clarifying questions rather than guessing`;
}

/**
 * Execute streaming and return the response
 */
async function executeStreaming(params: {
  messages: UIMessage[];
  modelConfig: { provider: string; model_id: string };
  userId: number;
  sessionId: string;
  conversationId: string;
  conversationIdValue?: string;
  conversationTitle: string;
  requestId: string;
  dbModelId: number;
  log: ReturnType<typeof createLogger>;
  timer: (data: Record<string, unknown>) => void;
}): Promise<Response> {
  const {
    messages, modelConfig, userId, sessionId, conversationId,
    conversationIdValue, conversationTitle, requestId, dbModelId, log, timer,
  } = params;

  const systemPrompt = await buildSystemPrompt();
  const decisionTools = createDecisionCaptureTools(userId);

  const onFinish = async ({
    text,
    usage,
    finishReason,
    toolCalls,
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
      toolCallCount: toolCalls?.length || 0,
    });

    try {
      await saveAssistantMessage({ conversationId, text, usage, finishReason, toolCalls, dbModelId });
    } catch (saveError) {
      log.error('Failed to save assistant message', { error: saveError, conversationId });
    }

    timer({ status: 'success', conversationId, tokensUsed: usage?.totalTokens });
  };

  const streamRequest: StreamRequest = {
    messages,
    modelId: modelConfig.model_id,
    provider: modelConfig.provider,
    userId: userId.toString(),
    sessionId,
    conversationId,
    source: 'nexus',
    systemPrompt,
    tools: decisionTools,
    maxSteps: 10,
    callbacks: { onFinish },
  };

  log.info('Starting decision capture streaming', {
    provider: modelConfig.provider,
    model: modelConfig.model_id,
    conversationId,
    toolCount: Object.keys(decisionTools).length,
  });

  const streamResponse = await unifiedStreamingService.stream(streamRequest);

  const responseHeaders: Record<string, string> = {
    'X-Request-Id': requestId,
    'X-Unified-Streaming': 'true',
    'X-Supports-Reasoning': streamResponse.capabilities.supportsReasoning.toString(),
  };

  if (!conversationIdValue && conversationId) {
    responseHeaders['X-Conversation-Id'] = conversationId;
    responseHeaders['X-Conversation-Title'] = encodeURIComponent(conversationTitle || 'New Decision Capture');
  }

  return streamResponse.result.toUIMessageStreamResponse({ headers: responseHeaders });
}

// ============================================================================
// Route Handler (thin orchestrator)
// ============================================================================

/**
 * Decision Chat API - Streaming endpoint for decision capture
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.nexus.decision-chat');
  const log = createLogger({ requestId, route: 'api.nexus.decision-chat' });

  log.info('POST /api/nexus/decision-chat - Processing decision capture request');

  try {
    // 1. Parse and validate request
    const body = await req.json();
    const validation = validateRequest(body, requestId, log);
    if (!validation.valid) return validation.error;

    const { messages } = validation.data;
    const { conversationIdValue } = validation;

    log.info('Request parsed', sanitizeForLogging({
      messageCount: messages.length,
      hasConversationId: !!conversationIdValue,
    }));

    // 2. Authenticate and authorize
    const authResult = await authenticateAndAuthorize({ requestId, log, timer });
    if ('error' in authResult) return authResult.error;
    const { userId, sessionId } = authResult;

    // 3. Get model configuration
    const modelResult = await getDecisionModelConfig({ requestId, log });
    if ('error' in modelResult) return modelResult.error;
    const { modelConfig, dbModelId } = modelResult;

    // 4. Setup conversation and save user message
    const convSetup = await setupConversation({
      conversationIdValue, messages, userId,
      modelId: modelConfig.model_id, dbModelId,
    });
    if ('error' in convSetup) return convSetup.error;
    const { conversationId, conversationTitle } = convSetup;

    // 5. Convert messages and process attachments
    const messagesWithParts = convertMessagesToPartsFormat(messages as UIMessage[]);
    const { lightweightMessages } = await processMessagesWithAttachments(
      conversationId,
      messagesWithParts
    );

    // 6. Execute streaming
    return executeStreaming({
      messages: lightweightMessages as UIMessage[],
      modelConfig,
      userId,
      sessionId,
      conversationId,
      conversationIdValue,
      conversationTitle,
      requestId,
      dbModelId,
      log,
      timer,
    });

  } catch (error) {
    log.error('Decision chat API error', {
      error: error instanceof Error ? { message: error.message, name: error.name } : String(error),
    });

    timer({ status: 'error' });

    if (error instanceof ContentSafetyBlockedError) {
      return new Response(
        JSON.stringify({ error: error.message, code: 'CONTENT_BLOCKED', requestId }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
      );
    }

    // Handle missing setting gracefully
    if (error instanceof Error && error.message.includes('Required setting')) {
      return new Response(
        JSON.stringify({ error: 'Decision capture model not configured. Ask an administrator to set DECISION_CAPTURE_MODEL.', requestId }),
        { status: 500, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Failed to process decision capture request', requestId }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } }
    );
  }
}
