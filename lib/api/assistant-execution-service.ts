/**
 * Assistant Execution Service
 * Reusable service that wraps the prompt chain execution logic.
 * Can be called by both the web UI route and the v1 API route.
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 *
 * This service does NOT handle auth — callers must validate access before invoking.
 * It handles: execution record creation, prompt chain execution, streaming, and job management.
 */

import { UIMessage } from "ai"
import { z } from "zod"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { createLogger, startTimer, sanitizeForLogging } from "@/lib/logger"
import { getAIModelById } from "@/lib/db/drizzle"
import { executeQuery } from "@/lib/db/drizzle-client"
import { sql } from "drizzle-orm"
import { unifiedStreamingService } from "@/lib/streaming/unified-streaming-service"
import { retrieveKnowledgeForPrompt, formatKnowledgeContext } from "@/lib/assistant-architect/knowledge-retrieval"
import { ErrorFactories } from "@/lib/error-utils"
import { createRepositoryTools } from "@/lib/tools/repository-tools"
import type { StreamRequest } from "@/lib/streaming/types"
import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import { storeExecutionEvent } from "@/lib/assistant-architect/event-storage"

// ============================================
// Constants
// ============================================

const MAX_INPUT_SIZE_BYTES = 100000
const MAX_INPUT_FIELDS = 50
const MAX_PROMPT_CHAIN_LENGTH = 20
const MAX_PROMPT_CONTENT_SIZE = 10000000
const MAX_VARIABLE_REPLACEMENTS = 50

// ============================================
// Types
// ============================================

export interface ExecuteAssistantParams {
  assistantId: number
  inputs: Record<string, unknown>
  userId: number
  cognitoSub: string
  requestId: string
}

export interface ExecuteAssistantResult {
  /** The SSE stream response to return to the client */
  streamResponse: Response
  /** The execution record ID */
  executionId: number
}

interface ChainPrompt {
  id: number
  name: string
  content: string
  systemContext: string | null
  modelId: number | null
  position: number
  parallelGroup: number | null
  inputMapping: Record<string, string> | null
  repositoryIds: number[] | null
  enabledTools: string[] | null
  timeoutSeconds: number | null
}

interface PromptExecutionContext {
  previousOutputs: Map<number, string>
  accumulatedMessages: UIMessage[]
  executionId: number
  userCognitoSub: string
  assistantOwnerSub?: string
  userId: number
  executionStartTime: number
}

// ============================================
// Input Validation
// ============================================

const InputsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (inputs) => JSON.stringify(inputs).length <= MAX_INPUT_SIZE_BYTES,
    { message: `Input data exceeds maximum size of ${MAX_INPUT_SIZE_BYTES} bytes` }
  )
  .refine(
    (inputs) => Object.keys(inputs).length <= MAX_INPUT_FIELDS,
    { message: `Too many input fields (maximum ${MAX_INPUT_FIELDS})` }
  )

/**
 * Validate execution inputs. Returns validation issues or null if valid.
 */
export function validateExecutionInputs(
  inputs: unknown
): z.ZodIssue[] | null {
  const result = InputsSchema.safeParse(inputs)
  if (result.success) return null
  return result.error.issues
}

// ============================================
// Shared Execution Setup
// ============================================

interface ExecutionSetup {
  prompts: ChainPrompt[]
  context: PromptExecutionContext
  executionId: number
  log: ReturnType<typeof createLogger>
}

/**
 * Shared setup for assistant execution: loads assistant, validates prompts,
 * creates execution record, and emits start event.
 * Used by both streaming and job completion modes.
 */
async function prepareAssistantExecution(
  params: ExecuteAssistantParams
): Promise<ExecutionSetup> {
  const { assistantId, inputs, userId, cognitoSub, requestId } = params
  const log = createLogger({ requestId, action: "executeAssistant" })

  log.info("Starting assistant execution", { assistantId, userId })

  // 1. Load assistant configuration
  const architectResult = await getAssistantArchitectByIdAction(assistantId.toString())
  if (!architectResult.isSuccess || !architectResult.data) {
    throw ErrorFactories.dbRecordNotFound("assistant_architects", assistantId)
  }

  const architect = architectResult.data
  const prompts = (architect.prompts || []).sort((a, b) => a.position - b.position)

  if (!prompts || prompts.length === 0) {
    throw ErrorFactories.validationFailed([{
      field: "prompts",
      message: "No prompts configured for this assistant",
    }])
  }

  if (prompts.length > MAX_PROMPT_CHAIN_LENGTH) {
    throw ErrorFactories.validationFailed([{
      field: "prompts",
      message: `Prompt chain too long (${prompts.length}, maximum ${MAX_PROMPT_CHAIN_LENGTH})`,
    }])
  }

  log.info("Assistant loaded", sanitizeForLogging({
    assistantId,
    name: architect.name,
    promptCount: prompts.length,
  }))

  // 2. Create tool_execution record
  const inputData = Object.keys(inputs).length > 0 ? inputs : { __no_inputs: true }
  const inputDataJson = JSON.stringify(inputData)

  const executionResult = await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO tool_executions (user_id, input_data, status, started_at, assistant_architect_id)
      VALUES (${userId}, ${inputDataJson}::jsonb, 'running', ${new Date().toISOString()}::timestamp, ${assistantId})
      RETURNING id
    `),
    "createToolExecution"
  )

  const rows = executionResult as unknown as Array<{ id: number }>
  if (!rows || rows.length === 0 || !rows[0]?.id) {
    throw ErrorFactories.sysInternalError("Failed to create execution record")
  }

  const executionId = Number(rows[0].id)
  log.info("Execution record created", { executionId, assistantId })

  // 3. Emit execution-start event
  await storeExecutionEvent(executionId, "execution-start", {
    executionId,
    totalPrompts: prompts.length,
    toolName: architect.name,
  })

  // 4. Build execution context
  const context: PromptExecutionContext = {
    previousOutputs: new Map(),
    accumulatedMessages: [],
    executionId,
    userCognitoSub: cognitoSub,
    assistantOwnerSub: architect.userId ? String(architect.userId) : undefined,
    userId,
    executionStartTime: Date.now(),
  }

  return { prompts: prompts as ChainPrompt[], context, executionId, log }
}

/**
 * Handle execution failure: update DB record and emit error event.
 */
async function handleExecutionFailure(
  executionId: number,
  error: unknown,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error)
  await executeQuery(
    (db) => db.execute(sql`
      UPDATE tool_executions
      SET status = 'failed', error_message = ${errMsg}, completed_at = ${new Date().toISOString()}::timestamp
      WHERE id = ${executionId}
    `),
    "updateToolExecutionFailed"
  )

  await storeExecutionEvent(executionId, "execution-error", {
    executionId,
    error: errMsg,
    recoverable: false,
  }).catch((err) => log.error("Failed to store execution-error event", { error: err }))
}

// ============================================
// Core Execution
// ============================================

/**
 * Execute an assistant and return an SSE stream response.
 *
 * Caller is responsible for:
 * - Authentication and authorization
 * - Input validation (call validateExecutionInputs first)
 */
export async function executeAssistant(
  params: ExecuteAssistantParams
): Promise<ExecuteAssistantResult> {
  const timer = startTimer("assistantExecution")
  const setup = await prepareAssistantExecution(params)
  const { prompts, context, executionId, log } = setup

  try {
    const streamResponse = await executePromptChain(
      prompts,
      params.inputs,
      context,
      params.requestId,
      log
    )

    if (!streamResponse) {
      throw ErrorFactories.sysInternalError("No stream response generated from prompt execution")
    }

    timer({ status: "success" })
    log.info("Execution streaming started", { executionId, assistantId: params.assistantId })

    const response = streamResponse.result.toUIMessageStreamResponse({
      headers: {
        "X-Execution-Id": executionId.toString(),
        "X-Assistant-Id": params.assistantId.toString(),
        "X-Prompt-Count": prompts.length.toString(),
        "X-Request-Id": params.requestId,
      },
    })

    return { streamResponse: response, executionId }
  } catch (executionError) {
    await handleExecutionFailure(executionId, executionError, log)
    timer({ status: "error" })
    throw executionError
  }
}

/**
 * Get the final text output from an assistant execution.
 * Used by the async job mode to capture the full response text.
 */
export async function executeAssistantForJobCompletion(
  params: ExecuteAssistantParams
): Promise<{ text: string; executionId: number; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const setup = await prepareAssistantExecution(params)
  const { prompts, context, executionId, log } = setup

  try {
    const result = await executePromptChainForText(
      prompts,
      params.inputs,
      context,
      params.requestId,
      log
    )

    return { text: result.text, executionId, usage: result.usage }
  } catch (executionError) {
    await handleExecutionFailure(executionId, executionError, log)
    throw executionError
  }
}

// ============================================
// Prompt Chain Execution (Streaming)
// ============================================

async function executePromptChain(
  prompts: ChainPrompt[],
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>
) {
  const positionGroups = new Map<number, ChainPrompt[]>()
  for (const prompt of prompts) {
    if (!positionGroups.has(prompt.position)) {
      positionGroups.set(prompt.position, [])
    }
    positionGroups.get(prompt.position)!.push(prompt)
  }

  const sortedPositions = Array.from(positionGroups.keys()).sort((a, b) => a - b)
  let lastStreamResponse: Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined

  for (const position of sortedPositions) {
    const promptsAtPosition = positionGroups.get(position)!
    const isLastPosition = position === sortedPositions[sortedPositions.length - 1]

    if (promptsAtPosition.length > 1) {
      // Parallel execution
      const parallelPromises = promptsAtPosition.map((prompt, idx) =>
        executeSinglePromptWithCompletion(
          prompt,
          inputs,
          context,
          requestId,
          log,
          prompts.length,
          isLastPosition && idx === 0,
          prompts
        )
      )

      const results = await Promise.allSettled(parallelPromises)
      const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
      if (failures.length > 0) {
        const firstError = failures[0].reason
        const errMsg = firstError instanceof Error ? firstError.message : String(firstError)
        const truncated = errMsg.length > 200 ? errMsg.substring(0, 197) + "..." : errMsg
        throw ErrorFactories.sysInternalError(
          `${failures.length} of ${promptsAtPosition.length} parallel prompt(s) failed at position ${position}: ${truncated}`,
          { cause: firstError instanceof Error ? firstError : undefined }
        )
      }

      const successResults = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<typeof lastStreamResponse>[]
      const uiStreamResult = successResults.find((r) => r.value !== undefined)
      if (uiStreamResult?.value) {
        lastStreamResponse = uiStreamResult.value
      }
    } else {
      const prompt = promptsAtPosition[0]
      const isLastPrompt = isLastPosition
      const streamResponse = await executeSinglePromptWithCompletion(
        prompt,
        inputs,
        context,
        requestId,
        log,
        prompts.length,
        isLastPrompt,
        prompts
      )

      if (streamResponse) {
        lastStreamResponse = streamResponse
      }
    }
  }

  if (!lastStreamResponse) {
    throw ErrorFactories.sysInternalError("No stream response generated")
  }

  return lastStreamResponse
}

// ============================================
// Prompt Chain Execution (Text Collection for Jobs)
// ============================================

async function executePromptChainForText(
  prompts: ChainPrompt[],
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>
): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const positionGroups = new Map<number, ChainPrompt[]>()
  for (const prompt of prompts) {
    if (!positionGroups.has(prompt.position)) {
      positionGroups.set(prompt.position, [])
    }
    positionGroups.get(prompt.position)!.push(prompt)
  }

  const sortedPositions = Array.from(positionGroups.keys()).sort((a, b) => a - b)
  let lastText = ""
  let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

  for (const position of sortedPositions) {
    const promptsAtPosition = positionGroups.get(position)!
    const isLastPosition = position === sortedPositions[sortedPositions.length - 1]

    for (const prompt of promptsAtPosition) {
      const isLast = isLastPosition && prompt === promptsAtPosition[0]
      const result = await executeSinglePromptCollectText(
        prompt,
        inputs,
        context,
        requestId,
        log,
        prompts.length,
        isLast,
        prompts
      )

      if (isLast) {
        lastText = result.text
        lastUsage = result.usage
      }
    }
  }

  return { text: lastText, usage: lastUsage }
}

// ============================================
// Single Prompt Execution (Streaming)
// ============================================

async function executeSinglePromptWithCompletion(
  prompt: ChainPrompt,
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>,
  totalPrompts: number,
  isLastPrompt: boolean,
  prompts: ChainPrompt[]
) {
  const promptStartTime = Date.now()
  const promptTimer = startTimer(`prompt.${prompt.id}.execution`)

  await storeExecutionEvent(context.executionId, "prompt-start", {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    totalPrompts,
    modelId: String(prompt.modelId || "unknown"),
    hasKnowledge: !!(prompt.repositoryIds && prompt.repositoryIds.length > 0),
    hasTools: !!(prompt.enabledTools && prompt.enabledTools.length > 0),
  })

  try {
    if (!prompt.modelId) {
      throw ErrorFactories.validationFailed([{
        field: "modelId",
        message: `Prompt ${prompt.id} (${prompt.name}) has no model configured`,
      }])
    }

    // 1. Repository context
    let repositoryContext = ""
    if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
      await storeExecutionEvent(context.executionId, "knowledge-retrieval-start", {
        promptId: prompt.id,
        repositories: prompt.repositoryIds,
        searchType: "hybrid",
      })

      const knowledgeChunks = await retrieveKnowledgeForPrompt(
        prompt.content,
        prompt.repositoryIds,
        context.userCognitoSub,
        context.assistantOwnerSub,
        {
          maxChunks: 10,
          maxTokens: 4000,
          similarityThreshold: 0.7,
          searchType: "hybrid",
          vectorWeight: 0.8,
        },
        requestId
      )

      if (knowledgeChunks.length > 0) {
        repositoryContext = "\n\n" + formatKnowledgeContext(knowledgeChunks)
        const totalTokens = knowledgeChunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0)
        const avgRelevance = knowledgeChunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / knowledgeChunks.length

        await storeExecutionEvent(context.executionId, "knowledge-retrieved", {
          promptId: prompt.id,
          documentsFound: knowledgeChunks.length,
          relevanceScore: avgRelevance,
          tokens: totalTokens,
        })
      }
    }

    // 2. Variable substitution
    const inputMapping = (prompt.inputMapping || {}) as Record<string, string>
    const processedContent = substituteVariables(
      prompt.content,
      inputs,
      context.previousOutputs,
      inputMapping,
      prompts,
      prompt.position
    )

    // 3. Build messages
    const userMessage: UIMessage = {
      id: `prompt-${prompt.id}-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: processedContent + repositoryContext }],
    }

    const messages = [...context.accumulatedMessages, userMessage]

    // 4. Get model
    const modelData = await getAIModelById(prompt.modelId)
    if (!modelData || !modelData.modelId || !modelData.provider) {
      throw ErrorFactories.dbRecordNotFound("ai_models", prompt.modelId || "unknown")
    }

    const modelId = String(modelData.modelId)
    const provider = String(modelData.provider)

    // 5. Prepare tools
    const enabledTools: string[] = [...(prompt.enabledTools || [])]
    let promptTools = {}

    if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
      const repoTools = createRepositoryTools({
        repositoryIds: prompt.repositoryIds,
        userCognitoSub: context.userCognitoSub,
        assistantOwnerSub: context.assistantOwnerSub,
      })
      promptTools = { ...promptTools, ...repoTools }
    }

    // 6. Stream execution via Promise pattern
    return new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined>((resolve, reject) => {
      let resolveStreamResponse!: (value: Awaited<ReturnType<typeof unifiedStreamingService.stream>>) => void
      let rejectStreamResponse!: (error: Error) => void
      const streamResponsePromise = new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>>>((res, rej) => {
        resolveStreamResponse = res
        rejectStreamResponse = rej
      })

      const streamRequest: StreamRequest = {
        messages,
        modelId: String(modelId),
        provider: String(provider),
        userId: context.userId.toString(),
        sessionId: context.userCognitoSub,
        conversationId: undefined,
        source: "assistant_execution" as const,
        systemPrompt: prompt.systemContext || undefined,
        enabledTools,
        tools: Object.keys(promptTools).length > 0 ? promptTools : undefined,
        callbacks: {
          onFinish: async ({ text, usage }) => {
            try {
              const executionTimeMs = Date.now() - promptStartTime
              promptTimer({ status: "success", tokensUsed: usage?.totalTokens })

              const startedAt = new Date(Date.now() - executionTimeMs)

              const promptInputData = {
                originalContent: prompt.content,
                processedContent,
                repositoryContext: repositoryContext ? "included" : "none",
              }
              const inputDataJson = JSON.stringify(promptInputData)

              await executeQuery(
                (db) => db.execute(sql`
                  INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, started_at, completed_at, execution_time_ms)
                  VALUES (${context.executionId}, ${prompt.id}, ${inputDataJson}::jsonb, ${text || ""}, 'completed'::execution_status, ${startedAt.toISOString()}::timestamp, ${new Date().toISOString()}::timestamp, ${executionTimeMs})
                `),
                "savePromptResult"
              )

              context.previousOutputs.set(prompt.id, text || "")

              const assistantMessage: UIMessage = {
                id: `assistant-${prompt.id}-${Date.now()}`,
                role: "assistant",
                parts: [{ type: "text", text: text || "" }],
              }
              context.accumulatedMessages.push(userMessage, assistantMessage)

              await storeExecutionEvent(context.executionId, "prompt-complete", {
                promptId: prompt.id,
                outputTokens: usage?.completionTokens || 0,
                duration: executionTimeMs,
                cached: false,
              }).catch((err) => log.error("Failed to store prompt-complete event", { error: err }))

              if (isLastPrompt) {
                await executeQuery(
                  (db) => db.execute(sql`
                    UPDATE tool_executions
                    SET status = 'completed', completed_at = ${new Date().toISOString()}::timestamp
                    WHERE id = ${context.executionId}
                  `),
                  "updateToolExecutionCompleted"
                )

                const totalDuration = Date.now() - context.executionStartTime
                await storeExecutionEvent(context.executionId, "execution-complete", {
                  executionId: context.executionId,
                  totalTokens: usage?.totalTokens || 0,
                  duration: totalDuration,
                  success: true,
                }).catch((err) => log.error("Failed to store execution-complete event", { error: err }))
              }

              if (isLastPrompt) {
                try {
                  const streamResponse = await streamResponsePromise
                  resolve(streamResponse)
                } catch (streamError) {
                  reject(streamError)
                }
              } else {
                resolve(undefined)
              }
            } catch (saveError) {
              log.error("Failed to save prompt result", {
                error: saveError,
                promptId: prompt.id,
                executionId: context.executionId,
              })
              reject(saveError)
            }
          },
          onError: (error) => {
            promptTimer({ status: "error" })
            reject(error)
          },
        },
      }

      ;(async () => {
        try {
          const streamResponse = await unifiedStreamingService.stream(streamRequest)
          resolveStreamResponse(streamResponse)
        } catch (error) {
          promptTimer({ status: "error" })
          rejectStreamResponse(error as Error)
          reject(error)
        }
      })().catch((error) => {
        promptTimer({ status: "error" })
        rejectStreamResponse(error as Error)
        reject(error)
      })
    })
  } catch (promptError) {
    promptTimer({ status: "error" })

    await storeExecutionEvent(context.executionId, "execution-error", {
      executionId: context.executionId,
      error: promptError instanceof Error ? promptError.message : String(promptError),
      promptId: prompt.id,
      recoverable: false,
    }).catch((err) => log.error("Failed to store prompt error event", { error: err }))

    const now = new Date()
    const failedInputData = { prompt: prompt.content }
    const failedInputJson = JSON.stringify(failedInputData)
    const errorMsg = promptError instanceof Error ? promptError.message : String(promptError)

    await executeQuery(
      (db) => db.execute(sql`
        INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, error_message, started_at, completed_at)
        VALUES (${context.executionId}, ${prompt.id}, ${failedInputJson}::jsonb, '', 'failed'::execution_status, ${errorMsg}, ${now.toISOString()}::timestamp, ${now.toISOString()}::timestamp)
      `),
      "saveFailedPromptResult"
    )

    throw ErrorFactories.sysInternalError(
      `Prompt ${prompt.id} (${prompt.name}) failed: ${errorMsg}`,
      { cause: promptError instanceof Error ? promptError : undefined }
    )
  }
}

// ============================================
// Single Prompt Execution (Text Collection)
// ============================================

async function executeSinglePromptCollectText(
  prompt: ChainPrompt,
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>,
  totalPrompts: number,
  isLastPrompt: boolean,
  prompts: ChainPrompt[]
): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const promptStartTime = Date.now()
  const promptTimer = startTimer(`prompt.${prompt.id}.execution`)

  await storeExecutionEvent(context.executionId, "prompt-start", {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    totalPrompts,
    modelId: String(prompt.modelId || "unknown"),
    hasKnowledge: !!(prompt.repositoryIds && prompt.repositoryIds.length > 0),
    hasTools: !!(prompt.enabledTools && prompt.enabledTools.length > 0),
  })

  try {
    if (!prompt.modelId) {
      throw ErrorFactories.validationFailed([{
        field: "modelId",
        message: `Prompt ${prompt.id} (${prompt.name}) has no model configured`,
      }])
    }

    // Repository context
    let repositoryContext = ""
    if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
      const knowledgeChunks = await retrieveKnowledgeForPrompt(
        prompt.content,
        prompt.repositoryIds,
        context.userCognitoSub,
        context.assistantOwnerSub,
        { maxChunks: 10, maxTokens: 4000, similarityThreshold: 0.7, searchType: "hybrid", vectorWeight: 0.8 },
        requestId
      )

      if (knowledgeChunks.length > 0) {
        repositoryContext = "\n\n" + formatKnowledgeContext(knowledgeChunks)
      }
    }

    // Variable substitution
    const inputMapping = (prompt.inputMapping || {}) as Record<string, string>
    const processedContent = substituteVariables(
      prompt.content,
      inputs,
      context.previousOutputs,
      inputMapping,
      prompts,
      prompt.position
    )

    // Build messages
    const userMessage: UIMessage = {
      id: `prompt-${prompt.id}-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: processedContent + repositoryContext }],
    }

    const messages = [...context.accumulatedMessages, userMessage]

    // Get model
    const modelData = await getAIModelById(prompt.modelId)
    if (!modelData || !modelData.modelId || !modelData.provider) {
      throw ErrorFactories.dbRecordNotFound("ai_models", prompt.modelId || "unknown")
    }

    // Prepare tools
    const enabledTools: string[] = [...(prompt.enabledTools || [])]
    let promptTools = {}
    if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
      const repoTools = createRepositoryTools({
        repositoryIds: prompt.repositoryIds,
        userCognitoSub: context.userCognitoSub,
        assistantOwnerSub: context.assistantOwnerSub,
      })
      promptTools = { ...promptTools, ...repoTools }
    }

    // Stream and collect text
    return new Promise((resolve, reject) => {
      const streamRequest: StreamRequest = {
        messages,
        modelId: String(modelData.modelId),
        provider: String(modelData.provider),
        userId: context.userId.toString(),
        sessionId: context.userCognitoSub,
        source: "assistant_execution" as const,
        systemPrompt: prompt.systemContext || undefined,
        enabledTools,
        tools: Object.keys(promptTools).length > 0 ? promptTools : undefined,
        callbacks: {
          onFinish: async ({ text, usage }) => {
            try {
              const executionTimeMs = Date.now() - promptStartTime
              promptTimer({ status: "success", tokensUsed: usage?.totalTokens })

              const startedAt = new Date(Date.now() - executionTimeMs)
              const promptInputData = {
                originalContent: prompt.content,
                processedContent,
                repositoryContext: repositoryContext ? "included" : "none",
              }
              const inputDataJson = JSON.stringify(promptInputData)

              await executeQuery(
                (db) => db.execute(sql`
                  INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, started_at, completed_at, execution_time_ms)
                  VALUES (${context.executionId}, ${prompt.id}, ${inputDataJson}::jsonb, ${text || ""}, 'completed'::execution_status, ${startedAt.toISOString()}::timestamp, ${new Date().toISOString()}::timestamp, ${executionTimeMs})
                `),
                "savePromptResult"
              )

              context.previousOutputs.set(prompt.id, text || "")

              const assistantMessage: UIMessage = {
                id: `assistant-${prompt.id}-${Date.now()}`,
                role: "assistant",
                parts: [{ type: "text", text: text || "" }],
              }
              context.accumulatedMessages.push(userMessage, assistantMessage)

              await storeExecutionEvent(context.executionId, "prompt-complete", {
                promptId: prompt.id,
                outputTokens: usage?.completionTokens || 0,
                duration: executionTimeMs,
                cached: false,
              }).catch((err) => log.error("Failed to store prompt-complete event", { error: err }))

              if (isLastPrompt) {
                await executeQuery(
                  (db) => db.execute(sql`
                    UPDATE tool_executions
                    SET status = 'completed', completed_at = ${new Date().toISOString()}::timestamp
                    WHERE id = ${context.executionId}
                  `),
                  "updateToolExecutionCompleted"
                )

                const totalDuration = Date.now() - context.executionStartTime
                await storeExecutionEvent(context.executionId, "execution-complete", {
                  executionId: context.executionId,
                  totalTokens: usage?.totalTokens || 0,
                  duration: totalDuration,
                  success: true,
                }).catch((err) => log.error("Failed to store execution-complete event", { error: err }))
              }

              resolve({
                text: text || "",
                usage: usage ? {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                } : undefined,
              })
            } catch (saveError) {
              reject(saveError)
            }
          },
          onError: (error) => {
            promptTimer({ status: "error" })
            reject(error)
          },
        },
      }

      ;(async () => {
        try {
          await unifiedStreamingService.stream(streamRequest)
        } catch (error) {
          promptTimer({ status: "error" })
          reject(error)
        }
      })().catch(reject)
    })
  } catch (promptError) {
    promptTimer({ status: "error" })
    const errorMsg = promptError instanceof Error ? promptError.message : String(promptError)
    throw ErrorFactories.sysInternalError(
      `Prompt ${prompt.id} (${prompt.name}) failed: ${errorMsg}`,
      { cause: promptError instanceof Error ? promptError : undefined }
    )
  }
}

// ============================================
// Variable Substitution
// ============================================

/**
 * Slugify a string into a variable-safe name with hyphens.
 * Must match the slugify in prompt-editor-modal.tsx so UI variables resolve at runtime.
 */
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\da-z]+/g, "-")
    .replace(/(^-|-$)+/g, "")
}

function substituteVariables(
  content: string,
  inputs: Record<string, unknown>,
  previousOutputs: Map<number, string>,
  mapping: Record<string, string>,
  allPrompts: ChainPrompt[],
  currentPromptPosition: number
): string {
  if (content.length > MAX_PROMPT_CONTENT_SIZE) {
    throw ErrorFactories.validationFailed([{
      field: "content",
      message: `Prompt content exceeds maximum size of ${MAX_PROMPT_CONTENT_SIZE} characters`,
    }])
  }

  // Updated regex: [\w-]+ to match hyphenated slugified names (regression from #685)
  const placeholderMatches = content.match(/\${([\w-]+)}|{{([\w-]+)}}/g)
  const placeholderCount = placeholderMatches ? placeholderMatches.length : 0

  if (placeholderCount > MAX_VARIABLE_REPLACEMENTS) {
    throw ErrorFactories.validationFailed([{
      field: "content",
      message: `Too many variable placeholders (${placeholderCount}, maximum ${MAX_VARIABLE_REPLACEMENTS})`,
    }])
  }

  // Auto-inject previous prompt outputs as slugified variables (restored from pre-#685 behavior)
  const slugifiedOutputs = new Map<string, string>()
  const positionToPromptId = new Map<number, number>()
  const sortedPrevPrompts = allPrompts
    .filter(p => p.position < currentPromptPosition)
    .sort((a, b) => a.position - b.position)

  for (let i = 0; i < sortedPrevPrompts.length; i++) {
    const prevPrompt = sortedPrevPrompts[i]
    const output = previousOutputs.get(prevPrompt.id)
    if (output !== undefined) {
      // Map slugified name → output (e.g., "facilitator-opening" → output text)
      slugifiedOutputs.set(slugify(prevPrompt.name), output)
      // Map positional index → prompt ID for prompt_N_output support
      positionToPromptId.set(i, prevPrompt.id)
    }
  }

  return content.replace(/\${([\w-]+)}|{{([\w-]+)}}/g, (match, dollarVar, braceVar) => {
    const varName = dollarVar || braceVar

    // Path 1: Explicit inputMapping (backward compatible)
    if (mapping[varName]) {
      const mappedPath = mapping[varName]
      const promptMatch = mappedPath.match(/^prompt_(\d+)\.output$/)
      if (promptMatch) {
        const promptId = Number.parseInt(promptMatch[1], 10)
        const output = previousOutputs.get(promptId)
        if (output) return output
      }

      const value = resolvePath(mappedPath, { inputs, previousOutputs })
      if (value !== undefined && value !== null) return String(value)
    }

    // Path 2: User input fields
    if (varName in inputs) {
      const value = inputs[varName]
      return value !== undefined && value !== null ? String(value) : match
    }

    // Path 3: Slugified previous prompt names (restored from pre-#685)
    if (slugifiedOutputs.has(varName)) {
      return slugifiedOutputs.get(varName)!
    }

    // Path 4: prompt_N_output positional syntax
    const positionalMatch = varName.match(/^prompt_(\d+)_output$/)
    if (positionalMatch) {
      const position = Number.parseInt(positionalMatch[1], 10)
      const promptId = positionToPromptId.get(position)
      if (promptId !== undefined) {
        const output = previousOutputs.get(promptId)
        if (output !== undefined) return output
      }
    }

    return match
  })
}

function resolvePath(
  path: string,
  context: { inputs: Record<string, unknown>; previousOutputs: Map<number, string> }
): unknown {
  const parts = path.split(".")
  let current: unknown = context

  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }

  return current
}

/**
 * Check if an error is a ContentSafetyBlockedError (for route handlers to use)
 */
export function isContentSafetyBlocked(error: unknown): error is ContentSafetyBlockedError {
  return error instanceof ContentSafetyBlockedError
}
