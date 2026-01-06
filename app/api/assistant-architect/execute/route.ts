import { z } from 'zod';
import { UIMessage } from 'ai';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { getAssistantArchitectByIdAction } from '@/actions/db/assistant-architect-actions';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getAIModelById } from '@/lib/db/drizzle';
import { executeQuery } from '@/lib/db/drizzle-client';
import { eq, sql } from 'drizzle-orm';
import { toolExecutions, promptResults } from '@/lib/db/schema';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import { retrieveKnowledgeForPrompt, formatKnowledgeContext } from '@/lib/assistant-architect/knowledge-retrieval';
import { hasToolAccess, hasRole } from '@/utils/roles';
import { ErrorFactories } from '@/lib/error-utils';
import { createRepositoryTools } from '@/lib/tools/repository-tools';
import type { StreamRequest } from '@/lib/streaming/types';
import { storeExecutionEvent } from '@/lib/assistant-architect/event-storage';
import { safeJsonbStringify } from '@/lib/db/json-utils';

// Allow streaming responses up to 15 minutes for long chains
export const maxDuration = 900;

// Constants for resource limits
const MAX_INPUT_SIZE_BYTES = 100000; // 100KB max input size
const MAX_INPUT_FIELDS = 50; // Max 50 input fields
const MAX_PROMPT_CHAIN_LENGTH = 20; // Max 20 prompts per execution
const MAX_PROMPT_CONTENT_SIZE = 10000000; // 10MB max prompt content size (allows large context)
const MAX_VARIABLE_REPLACEMENTS = 50; // Max 50 variable placeholders per prompt (realistic upper bound)

// Request validation schema
const ExecuteRequestSchema = z.object({
  toolId: z.number().positive(),
  inputs: z.record(z.string(), z.unknown())
    .refine(
      (inputs) => {
        const jsonSize = JSON.stringify(inputs).length;
        return jsonSize <= MAX_INPUT_SIZE_BYTES;
      },
      { message: `Input data exceeds maximum size of ${MAX_INPUT_SIZE_BYTES} bytes` }
    )
    .refine(
      (inputs) => Object.keys(inputs).length <= MAX_INPUT_FIELDS,
      { message: `Too many input fields (maximum ${MAX_INPUT_FIELDS})` }
    ),
  conversationId: z.string().uuid().optional()
});

interface ChainPrompt {
  id: number;
  name: string;
  content: string;
  systemContext: string | null;
  modelId: number | null;
  /**
   * Execution position - prompts execute sequentially by position (0, then 1, then 2...).
   * Multiple prompts at the same position execute in parallel.
   */
  position: number;
  /**
   * Parallel group identifier (reserved for future use).
   * Currently, all prompts at the same position execute in parallel.
   * In future: Could enable multiple parallel groups within same position.
   *
   * TODO: Implement parallelGroup-based execution logic to support multiple
   * parallel groups within same position (e.g., [pos=0, group=A], [pos=0, group=B])
   */
  parallelGroup: number | null;
  inputMapping: Record<string, string> | null;
  repositoryIds: number[] | null;
  enabledTools: string[] | null;
  timeoutSeconds: number | null;
}

interface PromptExecutionContext {
  previousOutputs: Map<number, string>;
  accumulatedMessages: UIMessage[];
  executionId: number;
  userCognitoSub: string;
  assistantOwnerSub?: string;
  userId: number;
  executionStartTime: number;
}

/**
 * Assistant Architect Execution API - Native SSE Streaming
 *
 * Replaces polling-based execution with native streaming, supporting:
 * - Multi-prompt sequential execution with state management
 * - Variable substitution between prompts
 * - Repository context injection (vector, keyword, hybrid search)
 * - Per-prompt tool configuration
 * - Database persistence via onFinish callbacks
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.assistant-architect.execute');
  const log = createLogger({ requestId, route: 'api.assistant-architect.execute' });

  log.info('POST /api/assistant-architect/execute - Processing execution request with streaming');

  try {
    // 1. Parse and validate request
    const body = await req.json();
    const validationResult = ExecuteRequestSchema.safeParse(body);

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

    const { toolId, inputs, conversationId } = validationResult.data;

    log.info('Request parsed', sanitizeForLogging({
      toolId,
      hasInputs: Object.keys(inputs).length > 0,
      inputKeys: Object.keys(inputs),
      conversationId
    }));

    // 2. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }

    log.debug('User authenticated', sanitizeForLogging({ userId: session.sub }));

    // 3. Check tool access permission
    const hasAccess = await hasToolAccess('assistant-architect');
    if (!hasAccess) {
      log.warn('User does not have assistant-architect tool access', { userId: session.sub });
      return new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'You do not have permission to use the Assistant Architect tool',
          requestId
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Get current user
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = currentUser.data.user.id;

    // 5. Load assistant architect configuration with prompts
    const architectResult = await getAssistantArchitectByIdAction(toolId.toString());
    if (!architectResult.isSuccess || !architectResult.data) {
      log.error('Assistant architect not found', { toolId });
      return new Response(
        JSON.stringify({
          error: 'Assistant architect not found',
          requestId
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const architect = architectResult.data;

    // SECURITY: Verify user has permission to execute this assistant architect
    // Allow execution if:
    // 1. User is the owner (can execute any of their own, regardless of status)
    // 2. User is an admin (can execute any assistant)
    // 3. The assistant is approved (any user with assistant-architect access can execute)
    const isOwner = architect.userId === userId;
    const isAdmin = await hasRole('administrator');
    const isApproved = architect.status === 'approved';

    // Determine access reason for logging
    let accessReason: string | null = null;
    if (isOwner) {
      accessReason = 'owner';
    } else if (isAdmin) {
      accessReason = 'admin';
    } else if (isApproved) {
      accessReason = 'approved';
    }

    if (!accessReason) {
      // No valid access path - deny execution
      log.warn('User does not have access to this assistant architect', {
        userId,
        toolId,
        architectOwnerId: architect.userId,
        status: architect.status,
        isOwner,
        isAdmin,
        isApproved
      });
      return new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'You do not have permission to execute this assistant architect',
          requestId
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Log successful authorization for audit trail
    log.info('Authorization granted for assistant architect execution', {
      userId,
      toolId,
      architectOwnerId: architect.userId,
      status: architect.status,
      accessReason
    });

    const prompts = (architect.prompts || []).sort((a, b) => a.position - b.position);

    if (!prompts || prompts.length === 0) {
      log.error('No prompts configured for assistant architect', { toolId });
      return new Response(
        JSON.stringify({
          error: 'No prompts configured for this assistant architect',
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate prompt chain length to prevent resource exhaustion
    if (prompts.length > MAX_PROMPT_CHAIN_LENGTH) {
      log.warn('Prompt chain too long', { promptCount: prompts.length, toolId, maxAllowed: MAX_PROMPT_CHAIN_LENGTH });
      return new Response(
        JSON.stringify({
          error: 'Prompt chain too long',
          message: `Maximum ${MAX_PROMPT_CHAIN_LENGTH} prompts allowed per execution`,
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    log.info('Assistant architect loaded', sanitizeForLogging({
      toolId,
      name: architect.name,
      promptCount: prompts.length,
      userId
    }));

    // 6. Create tool_execution record
    // WORKAROUND: Use explicit JSONB casting for AWS Data API compatibility
    // See: https://github.com/drizzle-team/drizzle-orm/issues/724
    const inputData = Object.keys(inputs).length > 0 ? inputs : { __no_inputs: true };

    const executionResult = await executeQuery(
      (db) => db.insert(toolExecutions)
        .values({
          assistantArchitectId: toolId,
          userId,
          inputData: sql`${safeJsonbStringify(inputData)}`,
          status: 'running',
          startedAt: new Date()
        })
        .returning({ id: toolExecutions.id }),
      'createToolExecution'
    );

    if (!executionResult || executionResult.length === 0 || !executionResult[0]?.id) {
      log.error('Failed to create tool execution', { toolId });
      return new Response(
        JSON.stringify({
          error: 'Failed to create execution record',
          requestId
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const executionId = Number(executionResult[0].id);
    log.info('Tool execution created', { executionId, toolId });

    // 7. Emit execution-start event
    await storeExecutionEvent(executionId, 'execution-start', {
      executionId,
      totalPrompts: prompts.length,
      toolName: architect.name
    });

    // 8. Execute prompt chain with streaming
    const context: PromptExecutionContext = {
      previousOutputs: new Map(),
      accumulatedMessages: [],
      executionId,
      userCognitoSub: session.sub,
      assistantOwnerSub: architect.userId ? String(architect.userId) : undefined,
      userId,
      executionStartTime: Date.now()
    };

    try {
      const streamResponse = await executePromptChain(prompts as ChainPrompt[], inputs, context, requestId, log);

      // 9. Update execution status to completed on stream completion
      // This is done in the onFinish callback of the last prompt

      // Return SSE stream with headers
      log.info('Returning streaming response', {
        executionId,
        toolId,
        promptCount: prompts.length,
        requestId,
        hasStreamResponse: !!streamResponse
      });

      if (!streamResponse) {
        throw ErrorFactories.sysInternalError('No stream response generated from prompt execution');
      }

      return streamResponse.result.toUIMessageStreamResponse({
        headers: {
          'X-Execution-Id': executionId.toString(),
          'X-Tool-Id': toolId.toString(),
          'X-Prompt-Count': prompts.length.toString(),
          'X-Request-Id': requestId
        }
      });

    } catch (executionError) {
      // Update execution status to failed
      await executeQuery(
        (db) => db.update(toolExecutions)
          .set({
            status: 'failed',
            errorMessage: executionError instanceof Error ? executionError.message : String(executionError),
            completedAt: new Date()
          })
          .where(eq(toolExecutions.id, executionId)),
        'updateToolExecutionFailed'
      );

      // Emit execution-error event
      await storeExecutionEvent(executionId, 'execution-error', {
        executionId,
        error: executionError instanceof Error ? executionError.message : String(executionError),
        recoverable: false,
        details: executionError instanceof Error ? executionError.stack : undefined
      }).catch(err => log.error('Failed to store execution-error event', { error: err }));

      throw executionError;
    }

  } catch (error) {
    log.error('Assistant architect execution error', {
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });

    timer({ status: 'error' });

    return new Response(
      JSON.stringify({
        error: 'Failed to execute assistant architect',
        message: error instanceof Error ? error.message : 'Unknown error',
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

/**
 * Execute a chain of prompts with support for parallel and sequential execution
 * - Prompts at same position execute in parallel using Promise.all()
 * - Prompts at different positions execute sequentially (position 0, then 1, then 2, etc.)
 * - Includes event emission for fine-grained progress tracking
 */
async function executePromptChain(
  prompts: ChainPrompt[],
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>
) {
  log.info('Starting prompt chain execution', {
    promptCount: prompts.length,
    executionId: context.executionId
  });

  // Group prompts by position for parallel/sequential execution
  const positionGroups = new Map<number, ChainPrompt[]>();
  for (const prompt of prompts) {
    const position = prompt.position;
    if (!positionGroups.has(position)) {
      positionGroups.set(position, []);
    }
    positionGroups.get(position)!.push(prompt);
  }

  // Sort positions to execute in order (0, 1, 2, ...)
  const sortedPositions = Array.from(positionGroups.keys()).sort((a, b) => a - b);

  log.info('Prompt execution plan', {
    totalPrompts: prompts.length,
    positions: sortedPositions.length,
    positionDetails: sortedPositions.map(pos => ({
      position: pos,
      promptCount: positionGroups.get(pos)!.length,
      prompts: positionGroups.get(pos)!.map(p => ({ id: p.id, name: p.name }))
    }))
  });

  let lastStreamResponse;

  // Execute each position sequentially
  for (const position of sortedPositions) {
    const promptsAtPosition = positionGroups.get(position)!;
    const isParallel = promptsAtPosition.length > 1;

    log.info('Executing position group', {
      position,
      promptCount: promptsAtPosition.length,
      isParallel,
      prompts: promptsAtPosition.map(p => ({ id: p.id, name: p.name }))
    });

    if (isParallel) {
      // Validate parallelGroup field usage
      const uniqueGroups = new Set(promptsAtPosition.map(p => p.parallelGroup).filter(g => g !== null));
      if (uniqueGroups.size > 1) {
        log.warn('Multiple parallel groups at same position - not yet supported', {
          position,
          groups: Array.from(uniqueGroups),
          promptIds: promptsAtPosition.map(p => p.id)
        });
      }

      // Execute prompts at this position in parallel
      const isLastPosition = position === sortedPositions[sortedPositions.length - 1];

      const parallelPromises = promptsAtPosition.map((prompt, idx) =>
        executeSinglePromptWithCompletion(
          prompt,
          inputs,
          context,
          requestId,
          log,
          prompts.length,
          // First prompt in last position gets stream response for UI
          isLastPosition && idx === 0
        )
      );

      // Wait for ALL prompts at this position to complete
      const results = await Promise.allSettled(parallelPromises);

      // Check for failures
      const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      if (failures.length > 0) {
        const firstError = failures[0].reason;
        const failedPromptIds = failures.map((_, idx) => promptsAtPosition[idx]?.id).filter(Boolean);

        log.error('Parallel prompt execution failed', {
          position,
          failureCount: failures.length,
          failedPromptIds,
          errors: failures.map(f => {
            const errMsg = f.reason instanceof Error ? f.reason.message : String(f.reason);
            return errMsg.length > 200 ? errMsg.substring(0, 197) + '...' : errMsg;
          })
        });

        // Wrap error in ErrorFactory for consistent error handling
        const firstErrorMsg = firstError instanceof Error ? firstError.message : String(firstError);
        const truncatedMsg = firstErrorMsg.length > 200 ? firstErrorMsg.substring(0, 197) + '...' : firstErrorMsg;

        throw ErrorFactories.sysInternalError(
          `${failures.length} of ${promptsAtPosition.length} parallel prompt(s) failed at position ${position}: ${truncatedMsg}`,
          {
            details: {
              position,
              failureCount: failures.length,
              totalPrompts: promptsAtPosition.length,
              failedPromptIds
            },
            cause: firstError instanceof Error ? firstError : undefined
          }
        );
      }

      // Extract successful stream responses
      const successResults = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<typeof lastStreamResponse>[];
      // Find the result explicitly marked for UI streaming (isLastPosition && idx === 0)
      // Only one parallel prompt gets isLastPrompt=true, so only one result has value !== undefined
      const uiStreamResult = successResults.find(r => r.value !== undefined);
      if (uiStreamResult?.value) {
        lastStreamResponse = uiStreamResult.value;
      }

      // Verify UI stream was assigned for last position
      if (isLastPosition && !lastStreamResponse) {
        throw ErrorFactories.sysInternalError(
          'Failed to assign UI stream response from last parallel group',
          {
            details: {
              position,
              successfulPrompts: successResults.length,
              totalPrompts: promptsAtPosition.length
            }
          }
        );
      }

    } else {
      // Single prompt at this position - execute sequentially
      const prompt = promptsAtPosition[0];
      const isLastPrompt = position === sortedPositions[sortedPositions.length - 1] && promptsAtPosition.length === 1;

      const streamResponse = await executeSinglePromptWithCompletion(
        prompt,
        inputs,
        context,
        requestId,
        log,
        prompts.length,
        isLastPrompt
      );

      if (streamResponse) {
        lastStreamResponse = streamResponse;
      }
    }
  }

  if (!lastStreamResponse) {
    throw ErrorFactories.sysInternalError('No stream response generated', {
      details: { promptCount: prompts.length, executionId: context.executionId }
    });
  }

  return lastStreamResponse;
}

/**
 * Execute a single prompt and wait for completion
 * Returns Promise that resolves when streaming finishes (onFinish callback completes)
 */
async function executeSinglePromptWithCompletion(
  prompt: ChainPrompt,
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>,
  totalPrompts: number,
  isLastPrompt: boolean
) {
  const promptStartTime = Date.now();
  const promptTimer = startTimer(`prompt.${prompt.id}.execution`);

  log.info('Executing prompt', {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    isLastPrompt,
    executionId: context.executionId
  });

  // Emit prompt-start event
  await storeExecutionEvent(context.executionId, 'prompt-start', {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    totalPrompts,
    modelId: String(prompt.modelId || 'unknown'),
    hasKnowledge: !!(prompt.repositoryIds && prompt.repositoryIds.length > 0),
    hasTools: !!(prompt.enabledTools && prompt.enabledTools.length > 0)
  });

  try {
    // Validate prompt has a model configured
    if (!prompt.modelId) {
      throw ErrorFactories.validationFailed([{
        field: 'modelId',
        message: `Prompt ${prompt.id} (${prompt.name}) has no model configured`
      }], {
        details: { promptId: prompt.id, promptName: prompt.name }
      });
    }

    // 1. Inject repository context if configured
    let repositoryContext = '';
    if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
      log.debug('Retrieving repository knowledge', {
        promptId: prompt.id,
        repositoryIds: prompt.repositoryIds
      });

      // Emit knowledge-retrieval-start event
      await storeExecutionEvent(context.executionId, 'knowledge-retrieval-start', {
        promptId: prompt.id,
        repositories: prompt.repositoryIds,
        searchType: 'hybrid'
      });

      const knowledgeChunks = await retrieveKnowledgeForPrompt(
        prompt.content,
        prompt.repositoryIds,
        context.userCognitoSub,
        context.assistantOwnerSub,
        {
          maxChunks: 10,
          maxTokens: 4000,
          similarityThreshold: 0.7,
          searchType: 'hybrid',
          vectorWeight: 0.8
        },
        requestId
      );

      if (knowledgeChunks.length > 0) {
        repositoryContext = '\n\n' + formatKnowledgeContext(knowledgeChunks);
        log.debug('Repository context retrieved', {
          promptId: prompt.id,
          chunkCount: knowledgeChunks.length
        });

        // Emit knowledge-retrieved event
        // NOTE: Token estimation uses rough approximation (character count / 4)
        // For precise token counts, consider using js-tiktoken encoder
        const totalTokens = knowledgeChunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        // Calculate average similarity score (safe due to length > 0 check above)
        const avgRelevance = knowledgeChunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / knowledgeChunks.length;

        await storeExecutionEvent(context.executionId, 'knowledge-retrieved', {
          promptId: prompt.id,
          documentsFound: knowledgeChunks.length,
          relevanceScore: avgRelevance,
          tokens: totalTokens
        });
      }
    }

    // 2. Apply variable substitution
    const inputMapping = (prompt.inputMapping || {}) as Record<string, string>;
    const processedContent = substituteVariables(
      prompt.content,
      inputs,
      context.previousOutputs,
      inputMapping
    );

    log.debug('Variables substituted', {
      promptId: prompt.id,
      originalLength: prompt.content.length,
      processedLength: processedContent.length
    });

    // Emit variable-substitution event if variables were used
    if (Object.keys(inputMapping).length > 0 || processedContent !== prompt.content) {
      const substitutedVars: Record<string, string> = {};
      const sourcePrompts: number[] = [];

      // Extract which variables were substituted
      for (const [varName, mappedPath] of Object.entries(inputMapping)) {
        const promptMatch = mappedPath.match(/^prompt_(\d+)\.output$/);
        if (promptMatch) {
          const sourcePromptId = Number.parseInt(promptMatch[1], 10);
          sourcePrompts.push(sourcePromptId);
          const value = context.previousOutputs.get(sourcePromptId);
          if (value) {
            substitutedVars[varName] = String(sanitizeForLogging(value)).substring(0, 500);
            log.debug('Variable substituted from previous output', {
              varName,
              sourcePromptId,
              fullLength: value.length,
              truncated: value.length > 500
            });
          }
        } else if (varName in inputs) {
          const inputValue = String(inputs[varName]);
          substitutedVars[varName] = String(sanitizeForLogging(inputValue)).substring(0, 500);
          if (inputValue.length > 500) {
            log.debug('Variable substituted from input (truncated)', {
              varName,
              fullLength: inputValue.length
            });
          }
        }
      }

      await storeExecutionEvent(context.executionId, 'variable-substitution', {
        promptId: prompt.id,
        variables: substitutedVars,
        sourcePrompts: Array.from(new Set(sourcePrompts))
      });
    }

    // 3. Build messages with accumulated context
    const userMessage: UIMessage = {
      id: `prompt-${prompt.id}-${Date.now()}`,
      role: 'user',
      parts: [{ type: 'text', text: processedContent + repositoryContext }]
    };

    const messages = [...context.accumulatedMessages, userMessage];

    // 4. Get AI model configuration
    const modelData = await getAIModelById(prompt.modelId);

    if (!modelData) {
      throw ErrorFactories.dbRecordNotFound('ai_models', prompt.modelId || 'unknown', {
        details: { promptId: prompt.id, modelId: prompt.modelId }
      });
    }

    // Validate model data
    if (!modelData.modelId || !modelData.provider) {
      throw ErrorFactories.dbRecordNotFound('ai_models', prompt.modelId || 'unknown', {
        details: { promptId: prompt.id, modelId: prompt.modelId, reason: 'Invalid model data' }
      });
    }

    const modelId = String(modelData.modelId);
    const provider = String(modelData.provider);

    // 5. Prepare tools for this prompt
    const enabledTools: string[] = [...(prompt.enabledTools || [])];
    let promptTools = {};

    // Create repository search tools if repositories are configured
    if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
      log.debug('Creating repository search tools', {
        promptId: prompt.id,
        repositoryIds: prompt.repositoryIds
      });

      const repoTools = createRepositoryTools({
        repositoryIds: prompt.repositoryIds,
        userCognitoSub: context.userCognitoSub,
        assistantOwnerSub: context.assistantOwnerSub
      });

      // Merge repository tools
      promptTools = { ...promptTools, ...repoTools };
    }

    log.debug('Tools configured for prompt', {
      promptId: prompt.id,
      enabledTools,
      toolCount: Object.keys(promptTools).length,
      tools: Object.keys(promptTools)
    });

    // 6. Wrap streaming in Promise that resolves on completion
    // Use Promise-based pattern to avoid race condition between stream creation and onFinish
    return new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined>((resolve, reject) => {
      // Promise to track when stream response is ready
      // Must handle both resolve AND reject to prevent hanging if IIFE fails
      let resolveStreamResponse!: (value: Awaited<ReturnType<typeof unifiedStreamingService.stream>>) => void;
      let rejectStreamResponse!: (error: Error) => void;
      const streamResponsePromise = new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>>>((res, rej) => {
        resolveStreamResponse = res;
        rejectStreamResponse = rej;
      });

      const streamRequest: StreamRequest = {
        messages,
        modelId: String(modelId),
        provider: String(provider),
        userId: context.userId.toString(),
        sessionId: context.userCognitoSub,
        conversationId: undefined, // Assistant architect doesn't use conversations
        source: 'assistant_execution' as const,
        systemPrompt: prompt.systemContext || undefined,
        enabledTools, // Keep for backward compatibility with other tools
        tools: Object.keys(promptTools).length > 0 ? promptTools : undefined, // Repository search tools
        callbacks: {
          onFinish: async ({ text, usage, finishReason }) => {

            log.info('Prompt execution finished', {
              promptId: prompt.id,
              promptName: prompt.name,
              hasText: !!text,
              textLength: text?.length || 0,
              hasUsage: !!usage,
              finishReason,
              executionId: context.executionId
            });

            try {
              // Calculate execution time as milliseconds
              const executionTimeMs = Date.now() - promptStartTime;

              // Log completion
              promptTimer({
                status: 'success',
                tokensUsed: usage?.totalTokens
              });

              // Save prompt result
              if (!text || text.length === 0) {
                log.warn('No text content from prompt execution', { promptId: prompt.id });
              }

              const startedAt = new Date(Date.now() - executionTimeMs);

              // WORKAROUND: Use explicit JSONB casting for AWS Data API compatibility
              const promptInputData = {
                originalContent: prompt.content,
                processedContent,
                repositoryContext: repositoryContext ? 'included' : 'none'
              };
              await executeQuery(
                (db) => db.insert(promptResults)
                  .values({
                    executionId: context.executionId,
                    promptId: prompt.id,
                    inputData: sql`${safeJsonbStringify(promptInputData)}::jsonb`,
                    outputData: text || '',
                    status: 'completed',
                    startedAt,
                    completedAt: new Date(),
                    executionTimeMs
                  }),
                'savePromptResult'
              );

              // Store output for next prompt's variable substitution
              context.previousOutputs.set(prompt.id, text || '');

              // Accumulate messages for context (only include reasonable text)
              const assistantMessage: UIMessage = {
                id: `assistant-${prompt.id}-${Date.now()}`,
                role: 'assistant',
                parts: [{ type: 'text', text: text || '' }]
              };
              context.accumulatedMessages.push(userMessage, assistantMessage);

              log.info('Prompt result saved successfully', {
                promptId: prompt.id,
                executionId: context.executionId,
                outputLength: text?.length || 0,
                executionTimeMs
              });

              // Emit prompt-complete event
              await storeExecutionEvent(context.executionId, 'prompt-complete', {
                promptId: prompt.id,
                outputTokens: usage?.completionTokens || 0,
                duration: executionTimeMs,
                cached: false // TODO: detect if response was cached
              }).catch(err => log.error('Failed to store prompt-complete event', { error: err }));

              // If this is the last prompt, update execution status to completed
              if (isLastPrompt) {
                await executeQuery(
                  (db) => db.update(toolExecutions)
                    .set({
                      status: 'completed',
                      completedAt: new Date()
                    })
                    .where(eq(toolExecutions.id, context.executionId)),
                  'updateToolExecutionCompleted'
                );

                // Emit execution-complete event
                const totalDuration = Date.now() - context.executionStartTime;
                await storeExecutionEvent(context.executionId, 'execution-complete', {
                  executionId: context.executionId,
                  totalTokens: usage?.totalTokens || 0,
                  duration: totalDuration,
                  success: true
                }).catch(err => log.error('Failed to store execution-complete event', { error: err }));

                log.info('Execution completed successfully', {
                  executionId: context.executionId,
                  totalPrompts
                });
              }

              // CRITICAL: Wait for stream response to be ready, then resolve
              // This ensures no race condition between stream assignment and onFinish
              if (isLastPrompt) {
                try {
                  const streamResponse = await streamResponsePromise;
                  resolve(streamResponse);
                } catch (streamError) {
                  // Stream creation failed, propagate error
                  log.error('Stream response promise rejected', {
                    error: streamError,
                    promptId: prompt.id
                  });
                  reject(streamError);
                }
              } else {
                resolve(undefined);
              }

            } catch (saveError) {
              log.error('Failed to save prompt result', {
                error: saveError,
                promptId: prompt.id,
                executionId: context.executionId
              });
              // Reject promise on save error
              reject(saveError);
            }
          },
          onError: (error) => {
            promptTimer({ status: 'error' });
            log.error('Prompt streaming error', { error, promptId: prompt.id });
            reject(error);
          }
        }
      };

      // 7. Start streaming and make response available to onFinish via Promise
      // Use IIFE to handle async operations without making Promise executor async
      (async () => {
        try {
          const streamResponse = await unifiedStreamingService.stream(streamRequest);

          log.info('Prompt stream started', {
            promptId: prompt.id,
            promptName: prompt.name,
            position: prompt.position
          });

          // Resolve the stream response promise so onFinish can access it
          resolveStreamResponse(streamResponse);

          // DO NOT resolve main promise here - wait for onFinish callback
          // onFinish will call resolve() when streaming completes
        } catch (error) {
          promptTimer({ status: 'error' });
          log.error('Failed to start prompt stream', {
            error,
            promptId: prompt.id
          });
          // CRITICAL: Reject streamResponsePromise to prevent onFinish from hanging
          rejectStreamResponse(error as Error);
          reject(error);
        }
      })().catch(error => {
        // Fallback for synchronous errors not caught by async try-catch
        promptTimer({ status: 'error' });
        log.error('Synchronous error in stream IIFE', {
          error,
          promptId: prompt.id
        });
        rejectStreamResponse(error as Error);
        reject(error);
      });
    });

  } catch (promptError) {
    promptTimer({ status: 'error' });

    log.error('Prompt execution failed', {
      error: promptError,
      promptId: prompt.id,
      promptName: prompt.name,
      executionId: context.executionId
    });

    // Emit execution-error event for prompt failure
    await storeExecutionEvent(context.executionId, 'execution-error', {
      executionId: context.executionId,
      error: promptError instanceof Error ? promptError.message : String(promptError),
      promptId: prompt.id,
      recoverable: false,
      details: promptError instanceof Error ? promptError.stack : undefined
    }).catch(err => log.error('Failed to store prompt error event', { error: err }));

    // Save failed prompt result
    // WORKAROUND: Use explicit JSONB casting for AWS Data API compatibility
    const now = new Date();
    const failedInputData = { prompt: prompt.content };
    await executeQuery(
      (db) => db.insert(promptResults)
        .values({
          executionId: context.executionId,
          promptId: prompt.id,
          inputData: sql`${safeJsonbStringify(failedInputData)}::jsonb`,
          outputData: '',
          status: 'failed',
          errorMessage: promptError instanceof Error ? promptError.message : String(promptError),
          startedAt: now,
          completedAt: now
        }),
      'saveFailedPromptResult'
    );

    // For now, stop execution on first error
    // Future enhancement: check prompt.stop_on_error field
    throw ErrorFactories.sysInternalError(
      `Prompt ${prompt.id} (${prompt.name}) failed: ${
        promptError instanceof Error ? promptError.message : String(promptError)
      }`,
      {
        details: { promptId: prompt.id, promptName: prompt.name },
        cause: promptError instanceof Error ? promptError : undefined
      }
    );
  }
}

/**
 * Substitute variable placeholders in prompt content
 *
 * Supports both ${variable} and {{variable}} syntax:
 * - Direct input mapping: ${userInput} or {{userInput}} -> inputs.userInput
 * - Mapped variables: ${topic} with mapping {"topic": "userInput.subject"}
 * - Previous outputs: ${previousAnalysis} with mapping {"previousAnalysis": "prompt_1.output"}
 *
 * Security: Validates content size and placeholder count to prevent DoS attacks
 */
function substituteVariables(
  content: string,
  inputs: Record<string, unknown>,
  previousOutputs: Map<number, string>,
  mapping: Record<string, string>
): string {
  // Validate content size before processing to prevent resource exhaustion
  if (content.length > MAX_PROMPT_CONTENT_SIZE) {
    throw ErrorFactories.validationFailed([{
      field: 'content',
      message: `Prompt content exceeds maximum size of ${MAX_PROMPT_CONTENT_SIZE} characters`
    }]);
  }

  // Count variable placeholders to prevent DoS via excessive replacements
  const placeholderMatches = content.match(/\${(\w+)}|{{(\w+)}}/g);
  const placeholderCount = placeholderMatches ? placeholderMatches.length : 0;

  if (placeholderCount > MAX_VARIABLE_REPLACEMENTS) {
    throw ErrorFactories.validationFailed([{
      field: 'content',
      message: `Too many variable placeholders (${placeholderCount}, maximum ${MAX_VARIABLE_REPLACEMENTS})`
    }]);
  }

  // Match both ${variable} and {{variable}} patterns
  return content.replace(/\${(\w+)}|{{(\w+)}}/g, (match, dollarVar, braceVar) => {
    const varName = dollarVar || braceVar;

    // 1. Check if there's an input mapping for this variable
    if (mapping[varName]) {
      const mappedPath = mapping[varName];

      // Handle prompt output references: "prompt_X.output"
      const promptMatch = mappedPath.match(/^prompt_(\d+)\.output$/);
      if (promptMatch) {
        const promptId = Number.parseInt(promptMatch[1], 10);
        const output = previousOutputs.get(promptId);
        if (output) {
          return output;
        }
      }

      // Handle nested input paths: "userInput.subject"
      const value = resolvePath(mappedPath, { inputs, previousOutputs });
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }

    // 2. Try direct input lookup
    if (varName in inputs) {
      const value = inputs[varName];
      return value !== undefined && value !== null ? String(value) : match;
    }

    // 3. No match found, return original placeholder
    return match;
  });
}

/**
 * Resolve a dot-notation path like "userInput.subject" or "prompt_1.output"
 */
function resolvePath(
  path: string,
  context: { inputs: Record<string, unknown>; previousOutputs: Map<number, string> }
): unknown {
  const parts = path.split('.');
  let current: unknown = context;

  for (const part of parts) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}
