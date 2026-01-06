import { z } from 'zod';
import { NextRequest } from 'next/server';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { ErrorFactories } from '@/lib/error-utils';
import { getUserById, getAssistantArchitectById, getChainPrompts, getAIModelById } from '@/lib/db/drizzle';
import { executeQuery } from '@/lib/db/drizzle-client';
import { eq, desc, sql } from 'drizzle-orm';
import { toolExecutions, promptResults, executionResults, scheduledExecutions } from '@/lib/db/schema';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import { retrieveKnowledgeForPrompt, formatKnowledgeContext } from '@/lib/assistant-architect/knowledge-retrieval';
import { createRepositoryTools } from '@/lib/tools/repository-tools';
import type { StreamRequest } from '@/lib/streaming/types';
import type { UIMessage } from 'ai';
import jwt from 'jsonwebtoken';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { safeJsonbStringify } from '@/lib/db/json-utils';

// Allow up to 15 minutes for long scheduled executions
export const maxDuration = 900;

// Constants for resource limits
const MAX_INPUT_SIZE_BYTES = 100000; // 100KB max input size
const MAX_PROMPT_CHAIN_LENGTH = 20; // Max 20 prompts per execution
const MAX_RESPONSE_SIZE_BYTES = 10485760; // 10MB max response size
const MAX_ACCUMULATED_CONTEXT_MESSAGES = Number.parseInt(
  process.env.MAX_CONTEXT_MESSAGES || '10',
  10
); // Keep last 10 messages (5 user/assistant exchanges) - configurable via env

// Request validation schema
const ScheduledExecuteRequestSchema = z.object({
  scheduleId: z.string().or(z.number()).transform(val => Number(val)),
  toolId: z.number().positive(),
  inputs: z.record(z.string(), z.unknown())
    .refine(
      (inputs) => {
        const jsonSize = JSON.stringify(inputs).length;
        return jsonSize <= MAX_INPUT_SIZE_BYTES;
      },
      { message: `Input data exceeds maximum size of ${MAX_INPUT_SIZE_BYTES} bytes` }
    ),
  userId: z.number().positive(),
  triggeredBy: z.enum(['eventbridge', 'manual']),
  scheduledAt: z.string()
});

interface ChainPrompt {
  id: number;
  name: string;
  content: string;
  systemContext: string | null;
  modelId: number | null;
  position: number;
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
}

/**
 * Internal authentication - validates JWT token from schedule-executor Lambda
 * Returns the decoded payload if valid, null otherwise
 */
function validateInternalRequest(req: NextRequest): { scheduleId: string; executionId: string } | null {
  const log = createLogger({ operation: 'validateInternalRequest' });

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    log.warn('Missing or invalid authorization header');
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  const internalSecret = process.env.INTERNAL_API_SECRET;

  if (!internalSecret) {
    log.error('INTERNAL_API_SECRET not configured');
    return null;
  }

  try {
    // Verify JWT with algorithm restriction and claim validation to prevent:
    // - Algorithm confusion attacks (by specifying algorithms: ['HS256'])
    // - Timing attacks (by validating claims in jwt.verify options)
    const decoded = jwt.verify(token, internalSecret, {
      algorithms: ['HS256'],
      issuer: 'schedule-executor',
      audience: 'assistant-architect-api'
    }) as { scheduleId: string; executionId: string };

    log.info('Internal request validated successfully', {
      scheduleId: decoded.scheduleId,
      executionId: decoded.executionId
    });
    return decoded;
  } catch (error) {
    log.warn('JWT verification failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Send notification to SQS queue for email delivery
 */
async function sendNotificationToQueue(
  executionResultId: number,
  userId: number,
  scheduleName: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const notificationQueueUrl = process.env.NOTIFICATION_QUEUE_URL;

  if (!notificationQueueUrl) {
    log.warn('NOTIFICATION_QUEUE_URL not configured - skipping notification');
    return;
  }

  try {
    const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const message = {
      executionResultId,
      userId,
      notificationType: 'email',
      scheduleName
    };

    const command = new SendMessageCommand({
      QueueUrl: notificationQueueUrl,
      MessageBody: JSON.stringify(message)
    });

    await sqsClient.send(command);

    log.info('Notification queued successfully', {
      executionResultId,
      userId,
      scheduleName
    });
  } catch (error) {
    log.error('Failed to queue notification', {
      error: error instanceof Error ? error.message : String(error),
      executionResultId,
      userId
    });
    // Don't throw - notification failure shouldn't fail the execution
  }
}

/**
 * Assistant Architect Scheduled Execution API - Server-Side Streaming
 *
 * Handles scheduled executions triggered by EventBridge via Lambda.
 * Executes streaming internally without SSE, saving complete results to database.
 */
export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.assistant-architect.execute.scheduled');
  const log = createLogger({ requestId, route: 'api.assistant-architect.execute.scheduled' });

  log.info('POST /api/assistant-architect/execute/scheduled - Processing scheduled execution');

  try {
    // 1. Validate internal authentication and extract JWT payload
    const jwtPayload = validateInternalRequest(req);
    if (!jwtPayload) {
      log.warn('Unauthorized internal request');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response(
        JSON.stringify({ error: 'Unauthorized', requestId }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const executionResultId = Number(jwtPayload.executionId);
    log.info('Extracted execution result ID from JWT', { executionResultId });

    // 2. Parse and validate request
    const body = await req.json();
    const validationResult = ScheduledExecuteRequestSchema.safeParse(body);

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

    const { scheduleId, toolId, inputs, userId, triggeredBy, scheduledAt } = validationResult.data;

    log.info('Scheduled execution request parsed', sanitizeForLogging({
      scheduleId,
      toolId,
      userId,
      triggeredBy,
      scheduledAt,
      hasInputs: Object.keys(inputs).length > 0,
      inputKeys: Object.keys(inputs)
    }));

    // 3. Get user's cognito_sub for context
    const user = await getUserById(userId);

    if (!user || !user.cognitoSub) {
      log.error('User not found or missing cognito_sub', { userId });
      return new Response(
        JSON.stringify({
          error: 'User not found',
          requestId
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const userCognitoSub = user.cognitoSub;

    // 4. Load assistant architect configuration with prompts
    const architect = await getAssistantArchitectById(toolId);

    if (!architect) {
      log.error('Assistant architect not found', { toolId });
      return new Response(
        JSON.stringify({
          error: 'Assistant architect not found',
          requestId
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 5. Load prompts for this assistant architect
    const promptsResult = await getChainPrompts(toolId);

    if (!promptsResult || promptsResult.length === 0) {
      log.error('No prompts configured for assistant architect', { toolId });
      return new Response(
        JSON.stringify({
          error: 'No prompts configured for this assistant architect',
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const prompts: ChainPrompt[] = promptsResult.map(p => ({
      id: p.id,
      name: p.name,
      content: p.content,
      systemContext: p.systemContext,
      modelId: p.modelId,
      position: p.position,
      inputMapping: p.inputMapping as Record<string, string> | null,
      repositoryIds: p.repositoryIds as number[] | null,
      enabledTools: p.enabledTools as string[] | null,
      timeoutSeconds: p.timeoutSeconds
    }));

    // Validate prompt chain length
    if (prompts.length > MAX_PROMPT_CHAIN_LENGTH) {
      log.warn('Prompt chain too long', { promptCount: prompts.length, toolId });
      return new Response(
        JSON.stringify({
          error: 'Prompt chain too long',
          message: `Maximum ${MAX_PROMPT_CHAIN_LENGTH} prompts allowed per execution`,
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    log.info('Assistant architect loaded for scheduled execution', sanitizeForLogging({
      toolId,
      name: architect.name,
      promptCount: prompts.length,
      userId,
      scheduleId
    }));

    // 6. Create tool_execution record
    // WORKAROUND: Drizzle ORM AWS Data API driver has issues with JSONB serialization.
    // Explicitly stringify and cast to jsonb to ensure proper parameter binding.
    // See: https://github.com/drizzle-team/drizzle-orm/issues/724
    // Related: Issue #599
    const inputData = Object.keys(inputs).length > 0 ? inputs : { __no_inputs: true };

    const executionResult = await executeQuery(
      (db) => db.insert(toolExecutions)
        .values({
          assistantArchitectId: toolId,
          userId,
          inputData: inputData,
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
    log.info('Tool execution created for scheduled run', { executionId, toolId, scheduleId });

    // 7. Execute prompt chain server-side (no SSE)
    const context: PromptExecutionContext = {
      previousOutputs: new Map(),
      accumulatedMessages: [],
      executionId,
      userCognitoSub,
      assistantOwnerSub: architect.userId ? String(architect.userId) : undefined,
      userId
    };

    try {
      // Capture start time for duration calculation
      const executionStartTime = Date.now();

      // Execute chain and collect complete response
      await executePromptChainServerSide(prompts, inputs, context, requestId, log);

      // Calculate execution duration
      const executionDurationMs = Date.now() - executionStartTime;

      // Update execution status to completed
      await executeQuery(
        (db) => db.update(toolExecutions)
          .set({
            status: 'completed',
            completedAt: new Date()
          })
          .where(eq(toolExecutions.id, executionId)),
        'updateToolExecutionCompleted'
      );

      // Query prompt_results to get the final AI output
      const promptResultsQuery = await executeQuery(
        (db) => db.select({ outputData: promptResults.outputData })
          .from(promptResults)
          .where(eq(promptResults.executionId, executionId))
          .orderBy(desc(promptResults.id))
          .limit(1),
        'getLastPromptResult'
      );

      const resultData = promptResultsQuery && promptResultsQuery.length > 0 && promptResultsQuery[0].outputData
        ? { output: promptResultsQuery[0].outputData, executionId, toolId }
        : { output: 'No output generated', executionId, toolId };

      log.info('Retrieved prompt results', {
        executionId,
        hasOutput: !!promptResultsQuery && promptResultsQuery.length > 0,
        hasOutputData: !!promptResultsQuery?.[0]?.outputData,
        outputLength: promptResultsQuery?.[0]?.outputData?.length || 0
      });

      // Update execution_results for UI/notification with result data and duration
      // WORKAROUND: Use explicit JSONB casting for AWS Data API compatibility
      await executeQuery(
        (db) => db.update(executionResults)
          .set({
            status: 'success',
            executedAt: new Date(),
            resultData: sql`${safeJsonbStringify(resultData)}::jsonb`,
            executionDurationMs
          })
          .where(eq(executionResults.id, executionResultId)),
        'updateExecutionResultSuccess'
      );

      // Get schedule name for notification
      const scheduleQuery = await executeQuery(
        (db) => db.select({ name: scheduledExecutions.name })
          .from(scheduledExecutions)
          .where(eq(scheduledExecutions.id, scheduleId))
          .limit(1),
        'getScheduleName'
      );

      const scheduleName = scheduleQuery && scheduleQuery.length > 0
        ? scheduleQuery[0].name
        : 'Scheduled Execution';

      // Send notification to SQS queue
      await sendNotificationToQueue(executionResultId, userId, scheduleName, log);

      timer({ status: 'success' });
      log.info('Scheduled execution completed successfully', {
        executionId,
        toolId,
        scheduleId,
        promptCount: prompts.length,
        durationMs: executionDurationMs,
        executionResultId,
        scheduleName
      });

      return new Response(
        JSON.stringify({
          message: 'Scheduled execution completed successfully',
          executionId,
          toolId,
          scheduleId,
          promptCount: prompts.length,
          requestId
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Execution-Id': executionId.toString(),
            'X-Tool-Id': toolId.toString(),
            'X-Schedule-Id': scheduleId.toString(),
            'X-Request-Id': requestId
          }
        }
      );

    } catch (executionError) {
      const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);

      // Update execution status to failed
      await executeQuery(
        (db) => db.update(toolExecutions)
          .set({
            status: 'failed',
            errorMessage,
            completedAt: new Date()
          })
          .where(eq(toolExecutions.id, executionId)),
        'updateToolExecutionFailed'
      );

      // Update execution_results for UI/notification using direct ID
      await executeQuery(
        (db) => db.update(executionResults)
          .set({
            status: 'failed',
            errorMessage,
            executedAt: new Date()
          })
          .where(eq(executionResults.id, executionResultId)),
        'updateExecutionResultFailed'
      );

      // Return sanitized error response instead of re-throwing
      timer({ status: 'error' });
      log.error('Execution failed', {
        error: errorMessage,
        executionId
      });

      return new Response(
        JSON.stringify({
          error: 'Execution failed',
          message: 'Scheduled execution encountered an error',
          executionId,
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

  } catch (error) {
    log.error('Scheduled execution error', {
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });

    timer({ status: 'error' });

    return new Response(
      JSON.stringify({
        error: 'Failed to execute scheduled assistant architect',
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
 * Execute prompt chain server-side without SSE
 * Collects complete response in memory
 */
async function executePromptChainServerSide(
  prompts: ChainPrompt[],
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>
) {
  log.info('Starting server-side prompt chain execution', {
    promptCount: prompts.length,
    executionId: context.executionId
  });

  for (const prompt of prompts) {
    const promptStartTime = Date.now();
    const promptTimer = startTimer(`prompt.${prompt.id}.execution`);

    log.info('Executing prompt server-side', {
      promptId: prompt.id,
      promptName: prompt.name,
      position: prompt.position,
      executionId: context.executionId
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
        }
      }

      // 2. Apply variable substitution with prompt execution order validation
      const inputMapping = (prompt.inputMapping || {}) as Record<string, string>;
      const processedContent = substituteVariables(
        prompt.content,
        inputs,
        context.previousOutputs,
        inputMapping,
        prompt.id
      );

      log.debug('Variables substituted', {
        promptId: prompt.id,
        originalLength: prompt.content.length,
        processedLength: processedContent.length
      });

      // 3. Build messages with accumulated context
      const userMessage: UIMessage = {
        id: `prompt-${prompt.id}-${Date.now()}`,
        role: 'user',
        parts: [{ type: 'text', text: processedContent + repositoryContext }]
      };

      const messages = [...context.accumulatedMessages, userMessage];

      // 4. Get AI model configuration
      const modelData = await getAIModelById(prompt.modelId!);

      if (!modelData) {
        throw ErrorFactories.dbRecordNotFound('ai_models', prompt.modelId || 'unknown', {
          details: { promptId: prompt.id, modelId: prompt.modelId }
        });
      }

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

      // 6. Create streaming request with promise tracking for onFinish
      // Initialize promise before stream request to prevent race condition
      let finishPromiseResolve: () => void;
      let finishPromiseReject: (error: Error) => void;
      let promiseResolved = false; // Track if promise was resolved/rejected

      const finishPromise = new Promise<void>((resolve, reject) => {
        finishPromiseResolve = resolve;
        finishPromiseReject = reject;
      });

      // Set up per-prompt timeout if configured
      let promptTimeoutId: NodeJS.Timeout | null = null;
      if (prompt.timeoutSeconds) {
        promptTimeoutId = setTimeout(() => {
          if (!promiseResolved) {
            log.warn('Prompt execution timeout', {
              promptId: prompt.id,
              timeoutSeconds: prompt.timeoutSeconds
            });
            finishPromiseReject(
              new Error(`Prompt ${prompt.id} exceeded timeout of ${prompt.timeoutSeconds} seconds`)
            );
            promiseResolved = true;
          }
        }, prompt.timeoutSeconds * 1000);
      }

      const streamRequest: StreamRequest = {
        messages,
        modelId,
        provider,
        userId: context.userId.toString(),
        sessionId: context.userCognitoSub,
        conversationId: undefined,
        source: 'assistant_execution' as const,
        systemPrompt: prompt.systemContext || undefined,
        enabledTools,
        tools: Object.keys(promptTools).length > 0 ? promptTools : undefined,
        callbacks: {
          onFinish: async ({ text, usage, finishReason }) => {
            try {
              log.info('Prompt execution finished', {
                promptId: prompt.id,
                promptName: prompt.name,
                hasText: !!text,
                textLength: text?.length || 0,
                hasUsage: !!usage,
                finishReason,
                executionId: context.executionId
              });

              // Validate response size
              if (text && text.length > MAX_RESPONSE_SIZE_BYTES) {
                throw ErrorFactories.validationFailed([{
                  field: 'response',
                  message: `Response size ${text.length} bytes exceeds maximum of ${MAX_RESPONSE_SIZE_BYTES} bytes`
                }]);
              }

              // Calculate execution time as milliseconds
              const executionTimeMs = Date.now() - promptStartTime;

              // Log completion
              promptTimer({
                status: 'success',
                tokensUsed: usage?.totalTokens
              });

              // Validate response content
              const hasValidContent = text && text.length > 0;
              const resultStatus = hasValidContent ? 'completed' : 'completed';

              if (!hasValidContent) {
                log.warn('No text content from prompt execution', {
                  promptId: prompt.id,
                  finishReason,
                  note: 'Marked as completed but with warning in logs'
                });
              }

              // Calculate timestamps in application code to avoid SQL interval multiplication issues
              const completedAt = new Date();
              const startedAt = new Date(completedAt.getTime() - executionTimeMs);

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
                    status: resultStatus as 'completed',
                    startedAt,
                    completedAt,
                    executionTimeMs
                  }),
                'savePromptResult'
              );

              // Store output for next prompt's variable substitution
              context.previousOutputs.set(prompt.id, text || '');

              // Accumulate messages for context with window management
              const assistantMessage: UIMessage = {
                id: `assistant-${prompt.id}-${Date.now()}`,
                role: 'assistant',
                parts: [{ type: 'text', text: text || '' }]
              };
              context.accumulatedMessages.push(userMessage, assistantMessage);

              // Manage context window to prevent unbounded memory growth
              if (context.accumulatedMessages.length > MAX_ACCUMULATED_CONTEXT_MESSAGES * 2) {
                const trimCount = context.accumulatedMessages.length - MAX_ACCUMULATED_CONTEXT_MESSAGES * 2;
                context.accumulatedMessages = context.accumulatedMessages.slice(trimCount);
                log.debug('Trimmed accumulated context', {
                  trimmedMessages: trimCount,
                  remainingMessages: context.accumulatedMessages.length
                });
              }

              log.info('Prompt result saved successfully', {
                promptId: prompt.id,
                executionId: context.executionId,
                outputLength: text?.length || 0,
                executionTimeMs,
                status: resultStatus,
                accumulatedMessageCount: context.accumulatedMessages.length
              });

              // Clear timeout and resolve the finish promise to signal completion
              if (promptTimeoutId) clearTimeout(promptTimeoutId);
              finishPromiseResolve();
              promiseResolved = true;

            } catch (saveError) {
              log.error('Failed to save prompt result', {
                error: saveError,
                promptId: prompt.id,
                executionId: context.executionId
              });

              // Clear timeout and reject the finish promise to propagate error
              if (promptTimeoutId) clearTimeout(promptTimeoutId);
              finishPromiseReject(saveError instanceof Error ? saveError : new Error(String(saveError)));
              promiseResolved = true;
            }
          }
        }
      };

      // 7. Execute prompt with streaming (server-side collection)
      const streamResponse = await unifiedStreamingService.stream(streamRequest);

      // Wait for both stream completion AND result storage to prevent race condition
      await Promise.all([
        streamResponse.result.usage,
        finishPromise
      ]);

      log.info('Prompt execution completed', {
        promptId: prompt.id,
        promptName: prompt.name,
        position: prompt.position,
        of: prompts.length
      });

    } catch (promptError) {
      promptTimer({ status: 'error' });

      log.error('Prompt execution failed', {
        error: promptError,
        promptId: prompt.id,
        promptName: prompt.name,
        executionId: context.executionId
      });

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
}

/**
 * Substitute {{variable}} placeholders in prompt content with validation
 */
function substituteVariables(
  content: string,
  inputs: Record<string, unknown>,
  previousOutputs: Map<number, string>,
  mapping: Record<string, string>,
  currentPromptId?: number
): string {
  return content.replace(/{{(\w+)}}/g, (match, varName) => {
    // 1. Check if there's an input mapping for this variable
    if (mapping[varName]) {
      const mappedPath = mapping[varName];

      // Handle prompt output references: "prompt_X.output"
      const promptMatch = mappedPath.match(/^prompt_(\d+)\.output$/);
      if (promptMatch) {
        const promptId = Number.parseInt(promptMatch[1], 10);

        // Validate prompt execution order - referenced prompt must have already executed
        if (!previousOutputs.has(promptId)) {
          throw ErrorFactories.validationFailed([{
            field: 'inputMapping',
            message: `Prompt ${currentPromptId} references prompt_${promptId}.output but it hasn't executed yet. Check prompt execution order.`
          }], {
            details: {
              currentPromptId,
              referencedPromptId: promptId,
              variable: varName,
              mapping: mappedPath
            }
          });
        }

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
 * Resolve a dot-notation path like "userInput.subject" or "inputs.foo.bar"
 * Properly handles top-level disambiguation for inputs vs context object
 *
 * LIMITATION: Does not support array indexing (e.g., "users[0].name")
 * For arrays, the entire array will be returned when accessing the property name.
 *
 * @example
 * resolvePath("inputs.user.name", context) // ✓ Supported
 * resolvePath("user.name", context)        // ✓ Supported (defaults to inputs)
 * resolvePath("users[0].name", context)    // ✗ Not supported - returns entire users array
 */
function resolvePath(
  path: string,
  context: { inputs: Record<string, unknown>; previousOutputs: Map<number, string> }
): unknown {
  const parts = path.split('.');

  // Handle top-level path disambiguation
  let current: unknown;
  let remainingParts: string[];

  if (parts[0] === 'inputs') {
    // Path explicitly starts with 'inputs' - navigate from context.inputs
    current = context.inputs;
    remainingParts = parts.slice(1);
  } else {
    // Default: treat entire path as navigating from inputs
    current = context.inputs;
    remainingParts = parts;
  }

  // Navigate through remaining path parts
  for (const part of remainingParts) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}
