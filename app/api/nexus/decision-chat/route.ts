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

const DecisionChatRequestSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.any()).optional(),
    content: z.any().optional(),
    metadata: z.any().optional(),
  })),
  conversationId: z.string().nullable().optional(),
});

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

6. **Validate completeness**: Use \`validate_completeness\` to check if a decision subgraph has all required elements before proposing it.

When analyzing a transcript:
- Process one decision at a time
- Be thorough but concise in your proposals
- Use existing graph nodes when they match (set existingNodeId)
- Ask clarifying questions rather than guessing`;
}

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
    const result = DecisionChatRequestSchema.safeParse(body);
    if (!result.success) {
      log.warn('Invalid request format', {
        errors: result.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return new Response(
        JSON.stringify({ error: 'Invalid request format', details: result.error.issues, requestId }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { messages, conversationId: existingConversationId } = result.data;
    const conversationIdValue = existingConversationId || undefined;

    // Validate conversation ID format
    if (conversationIdValue) {
      const uuidValidation = z.string().uuid().safeParse(conversationIdValue);
      if (!uuidValidation.success) {
        log.warn('Invalid conversation ID format', { conversationId: conversationIdValue });
        return new Response(
          JSON.stringify({ error: 'Invalid conversation ID format', requestId }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    log.info('Request parsed', sanitizeForLogging({
      messageCount: messages.length,
      hasConversationId: !!conversationIdValue,
    }));

    // 2. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }

    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = currentUser.data.user.id;

    // 3. Get model from DECISION_CAPTURE_MODEL setting
    const modelId = await getRequiredSetting('DECISION_CAPTURE_MODEL');
    const modelConfig = await getModelConfig(modelId);
    if (!modelConfig) {
      log.error('Decision capture model not found', { modelId });
      return new Response(
        JSON.stringify({ error: 'Decision capture model not configured or unavailable', requestId }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const dbModelId = modelConfig.id;

    log.info('Model configured', sanitizeForLogging({
      provider: modelConfig.provider,
      modelId: modelConfig.model_id,
      dbId: dbModelId,
    }));

    // 4. Setup conversation
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
      if ('error' in convResult) return convResult.error;
      conversationId = convResult.conversationId;
    }

    // Save user message
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
      const { content, parts } = extractUserContent(lastMessage as UIMessage);
      await saveUserMessage({ conversationId, content, parts, dbModelId });
    }

    // 5. Convert messages and process attachments
    const messagesWithParts = convertMessagesToPartsFormat(messages as UIMessage[]);
    const { lightweightMessages } = await processMessagesWithAttachments(
      conversationId,
      messagesWithParts
    );

    // 6. Build system prompt and tools
    const systemPrompt = await buildSystemPrompt();
    const decisionTools = createDecisionCaptureTools(userId);

    // 7. Create onFinish callback
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

    // 8. Execute streaming (maxSteps allows multi-step tool use: search → propose → commit)
    const streamRequest: StreamRequest = {
      messages: lightweightMessages as UIMessage[],
      modelId: modelConfig.model_id,
      provider: modelConfig.provider,
      userId: userId.toString(),
      sessionId: session.sub,
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
