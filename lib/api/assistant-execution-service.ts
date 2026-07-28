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
import { INTERNAL_ASSISTANT_LOOKUP } from "@/lib/assistant-architect/internal-access"
import { createLogger, startTimer, sanitizeForLogging } from "@/lib/logger"
import { getUserById } from "@/lib/db/drizzle"
import { executeQuery } from "@/lib/db/drizzle-client"
import { sql } from "drizzle-orm"
import { unifiedStreamingService } from "@/lib/streaming/unified-streaming-service"
import {
  retrieveKnowledgeForPrompt,
  formatKnowledgeContext,
  retrieveAtriumKnowledgeForPrompt,
  formatAtriumKnowledgeContext,
} from "@/lib/assistant-architect/knowledge-retrieval"
import { requesterForUserId } from "@/lib/content/requester-from-auth"
import type { Requester } from "@/lib/content/types"
import { ErrorFactories } from "@/lib/error-utils"
import { createRepositoryTools } from "@/lib/tools/repository-tools"
import type { StreamRequest } from "@/lib/streaming/types"
import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import { storeExecutionEvent } from "@/lib/assistant-architect/event-storage"
import { decodeMdxEditorEscapes } from "@/lib/utils/text-sanitizer"
import {
  routeAssistantArchitectModel,
  type AssistantArchitectRoutingMetadata,
} from "@/lib/assistant-architect/model-router"
import type { AssistantModelFamily, AssistantModelRoutingMode } from "@/lib/db/schema/tables/assistant-architects"
import {
  preflightAssistantRepositoryAccess,
  REPOSITORY_ACCESS_CHANGED_MESSAGE,
} from "@/lib/assistant-architect/repository-access-preflight"
import {
  AssistantRuntimeRepositoryInputError,
  resolveAssistantRuntimeRepositoryInputs,
  type AssistantRuntimeRepositoryInputs,
} from "@/lib/assistant-architect/runtime-repository-inputs"
import {
  compareAssistantPromptExecutionOrder,
  createCoordinatedAssistantExecution,
  remainingAssistantExecutionTimeoutMs,
} from "@/lib/assistant-architect/execution-coordinator"

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
  /**
   * Programmatic API/MCP callers may execute only approved assistants. The
   * coordinator enforces this again under the assistant-row lock so an approval
   * change cannot race execution startup.
   */
  requireApproved?: boolean
  /**
   * A server-created preparation may be reused by entry points that must
   * validate and sanitize inputs before creating their own durable records.
   * Arbitrary caller-created objects are rejected by this module.
   */
  preparedInputs?: PreparedAssistantExecutionInputs
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
  /** Shared wall-clock deadline established with the execution row. */
  executionDeadlineAt: Date
  /** The assistant being executed — keys the Atrium retrieval_scope lookup. */
  assistantId: number
  modelRoutingMode: AssistantModelRoutingMode
  modelRoutingFamily: AssistantModelFamily | null
  modelRoutes: Map<number, AssistantArchitectRoutingMetadata>
  /**
   * The key owner's content Requester, or null when unresolvable. Atrium
   * retrieval is bounded per hit by THIS caller's canView; null skips it
   * entirely (fail closed to nothing) without failing the execution.
   */
  atriumRequester: Requester | null
  /** Temporary repositories resolved from opaque runtime attachment markers. */
  runtimeRepositoryIds: number[]
  /** Authoritative item labels used to improve retrieval queries. */
  runtimeRepositoryQuery: string
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

export function isAssistantRuntimeRepositoryInputError(
  error: unknown
): error is AssistantRuntimeRepositoryInputError {
  return error instanceof AssistantRuntimeRepositoryInputError
}

export interface PreparedAssistantExecutionInputs {
  /** Numeric owner identity used for the authoritative resolution. */
  ownerId: number
  /** Marker-free, authoritative-label inputs safe for persistence/providers. */
  inputs: Record<string, unknown>
  runtimeRepositoryIds: number[]
  runtimeRepositoryQuery: string
  references: AssistantRuntimeRepositoryInputs["references"]
}

// A WeakSet makes `preparedInputs` an opaque in-process capability. REST routes
// can reuse one resolution across pre-persistence validation and execution, but
// a future caller cannot bypass owner-bound resolution by constructing a
// lookalike object.
const preparedAssistantInputs = new WeakSet<PreparedAssistantExecutionInputs>()

/**
 * Resolve and sanitize canonical temporary repository markers as the executing
 * owner. Entry points that persist a conversation/job should call this before
 * those writes, then pass the returned object to the execution service.
 */
export async function prepareAssistantExecutionInputs(
  inputs: Record<string, unknown>,
  ownerId: number
): Promise<PreparedAssistantExecutionInputs> {
  const resolved = await resolveAssistantRuntimeRepositoryInputs(inputs, ownerId)
  const prepared: PreparedAssistantExecutionInputs = {
    ownerId,
    inputs: resolved.modelInputs,
    runtimeRepositoryIds: resolved.repositoryIds,
    runtimeRepositoryQuery: resolved.queryContext,
    references: resolved.references,
  }
  preparedAssistantInputs.add(prepared)
  return prepared
}

async function resolvePreparedAssistantInputs(
  params: ExecuteAssistantParams
): Promise<PreparedAssistantExecutionInputs> {
  if (params.preparedInputs) {
    if (
      !preparedAssistantInputs.has(params.preparedInputs) ||
      params.preparedInputs.ownerId !== params.userId
    ) {
      throw ErrorFactories.validationFailed([{
        field: "inputs",
        message: "Prepared assistant inputs are invalid",
      }])
    }
    return params.preparedInputs
  }
  return prepareAssistantExecutionInputs(params.inputs, params.userId)
}

// ============================================
// Shared Execution Setup
// ============================================

interface ExecutionSetup {
  prompts: ChainPrompt[]
  context: PromptExecutionContext
  executionId: number
  inputs: Record<string, unknown>
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
  const { assistantId, userId, cognitoSub, requestId } = params
  const log = createLogger({ requestId, action: "executeAssistant" })

  log.info("Starting assistant execution", { assistantId, userId })

  // Runtime markers are owner-bound and must be resolved before the execution
  // row below. Their repository IDs later join the normal executor-ACL
  // preflight; ownership of an assistant never lends access.
  const preparedInputs = await resolvePreparedAssistantInputs(params)

  // 1. Lock the assistant row and create the active execution record in one
  // transaction. Updates use the same row lock before checking active records:
  // whichever operation wins the lock establishes a safe ordering, so an
  // execution can never load prompt ids that a concurrent update then deletes.
  const coordinated = await createCoordinatedAssistantExecution({
    userId,
    assistantId,
    inputs: preparedInputs.inputs,
    requireApproved: params.requireApproved,
  })
  if (!coordinated.created) {
    if (coordinated.reason === "invalid_graph") {
      throw ErrorFactories.validationFailed([{
        field: "prompts",
        message:
          `Assistant prompt count must be between 1 and ${coordinated.maxPromptCount}`,
      }])
    }
    throw ErrorFactories.sysInternalError(
      "Unexpected assistant execution rate-limit result"
    )
  }
  const { executionId, startedAt, deadlineAt } = coordinated
  log.info("Execution record created", { executionId, assistantId })

  try {
    // 2. Load the configuration only after the execution record is visible.
    // A concurrent updater must now observe this record and return 409.
    const architectResult = await getAssistantArchitectByIdAction(
      assistantId.toString(),
      INTERNAL_ASSISTANT_LOOKUP
    )
    if (!architectResult.isSuccess || !architectResult.data) {
      throw ErrorFactories.dbRecordNotFound("assistant_architects", assistantId)
    }

    const architect = architectResult.data
    const prompts = requirePromptChainArchitect(architect)
    await requireAssistantRepositoryAccess(
      prompts,
      preparedInputs,
      cognitoSub,
      { assistantId, userId, log }
    )

    log.info("Assistant loaded", sanitizeForLogging({
      assistantId,
      modelRoutingMode: architect.modelRoutingMode ?? "legacy",
      modelRoutingFamily: architect.modelRoutingFamily ?? null,
      name: architect.name,
      promptCount: prompts.length,
    }))

    // 3. Emit execution-start event
    await storeExecutionEvent(executionId, "execution-start", {
      executionId,
      totalPrompts: prompts.length,
      toolName: architect.name,
    })

    // 4. Build execution context. The Atrium requester resolves the key owner's
    // roles/org for canView-bounded content retrieval (Phase 6, #1056);
    // requesterForUserId never throws — a failed resolve yields null, which
    // skips Atrium retrieval without failing the execution.
    // Resolve the assistant creator's cognito_sub so owner-based repository access
    // resolves for non-owner runs. This was String(architect.userId) — a numeric
    // users.id, which never equals the users.cognito_sub the knowledge/repository
    // access predicates compare against, so owner-shared private repos silently
    // returned zero chunks (REV-COR-511).
    const assistantOwnerSub = await resolveAssistantOwnerSub(architect.userId, log)

    const context: PromptExecutionContext = {
      previousOutputs: new Map(),
      accumulatedMessages: [],
      executionId,
      userCognitoSub: cognitoSub,
      assistantOwnerSub,
      userId,
      executionStartTime: startedAt.getTime(),
      executionDeadlineAt: deadlineAt,
      assistantId,
      modelRoutingMode: architect.modelRoutingMode ?? "legacy",
      modelRoutingFamily: architect.modelRoutingFamily ?? null,
      modelRoutes: new Map(),
      atriumRequester: await requesterForUserId(userId),
      runtimeRepositoryIds: preparedInputs.runtimeRepositoryIds,
      runtimeRepositoryQuery: preparedInputs.runtimeRepositoryQuery,
    }

    return {
      prompts: prompts as ChainPrompt[],
      context,
      executionId,
      inputs: preparedInputs.inputs,
      log,
    }
  } catch (setupError) {
    await handleExecutionFailure(executionId, setupError, log)
    throw setupError
  }
}

type ArchitectResult = NonNullable<
  Awaited<ReturnType<typeof getAssistantArchitectByIdAction>>["data"]
>

function requirePromptChainArchitect(architect: ArchitectResult): ChainPrompt[] {
  if (architect.mode === "agentic") {
    throw ErrorFactories.validationFailed([{
      field: "mode",
      message:
        "Agentic assistants are not supported on this execution surface. Run agentic assistants through the Assistant Architect UI.",
    }])
  }
  const prompts = (architect.prompts || []).sort(
    compareAssistantPromptExecutionOrder
  )
  if (prompts.length === 0) {
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
  return prompts as ChainPrompt[]
}

async function requireAssistantRepositoryAccess(
  prompts: ChainPrompt[],
  preparedInputs: PreparedAssistantExecutionInputs,
  cognitoSub: string,
  execution: {
    assistantId: number
    userId: number
    log: ReturnType<typeof createLogger>
  }
): Promise<void> {
  const accessInputs =
    preparedInputs.runtimeRepositoryIds.length > 0
      ? [...prompts, { repositoryIds: preparedInputs.runtimeRepositoryIds }]
      : prompts
  const repositoryAccess = await preflightAssistantRepositoryAccess(
    accessInputs,
    cognitoSub
  )
  if (repositoryAccess.isAllowed) return
  execution.log.warn("Assistant execution blocked because repository access changed", {
    assistantId: execution.assistantId,
    userId: execution.userId,
    repositoryCount: repositoryAccess.repositoryIds.length,
  })
  throw ErrorFactories.authzToolAccessDenied("assistant repository access", {
    userMessage: REPOSITORY_ACCESS_CHANGED_MESSAGE,
    technicalMessage:
      "Executing principal cannot access every repository bound to the assistant",
  })
}

async function resolveAssistantOwnerSub(
  ownerId: number | null,
  log: ReturnType<typeof createLogger>
): Promise<string | undefined> {
  if (!ownerId) return undefined
  try {
    return (await getUserById(ownerId))?.cognitoSub ?? undefined
  } catch (error) {
    log.warn("Failed to resolve assistant owner sub", {
      userId: ownerId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
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
  const { prompts, context, executionId, inputs, log } = setup

  try {
    const streamResponse = await executePromptChain(
      prompts,
      inputs,
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
  const { prompts, context, executionId, inputs, log } = setup

  try {
    const result = await executePromptChainForText(
      prompts,
      inputs,
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
        executeSinglePromptWithCompletion({
          prompt,
          inputs,
          context,
          requestId,
          log,
          totalPrompts: prompts.length,
          isLastPrompt: isLastPosition && idx === 0,
          completeExecution: false,
          prompts,
        })
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
      if (isLastPosition) {
        const completedUsages = results
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value.usage)
        await recordAssistantExecutionCompletion(
          context,
          log,
          aggregatePromptUsage(completedUsages)
        )
      }

      const successResults = results.filter(
        (r) => r.status === "fulfilled"
      ) as PromiseFulfilledResult<CompletedPromptStream>[]
      const uiStreamResult = successResults.find(
        (r) => r.value.streamResponse !== undefined
      )
      if (uiStreamResult?.value.streamResponse) {
        lastStreamResponse = uiStreamResult.value.streamResponse
      }
    } else {
      const prompt = promptsAtPosition[0]
      const isLastPrompt = isLastPosition
      const promptResult = await executeSinglePromptWithCompletion({
        prompt,
        inputs,
        context,
        requestId,
        log,
        totalPrompts: prompts.length,
        isLastPrompt,
        prompts,
      })

      if (promptResult.streamResponse) {
        lastStreamResponse = promptResult.streamResponse
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
    const positionUsages: Array<CollectedPromptText["usage"]> = []

    for (const prompt of promptsAtPosition) {
      const isLast = isLastPosition && prompt === promptsAtPosition[0]
      const result = await executeSinglePromptCollectText({
        prompt,
        inputs,
        context,
        requestId,
        log,
        totalPrompts: prompts.length,
        isLastPrompt: isLast,
        completeExecution: false,
        prompts,
      })
      positionUsages.push(result.usage)

      if (isLast) {
        lastText = result.text
      }
    }
    if (isLastPosition) {
      lastUsage = aggregatePromptUsage(positionUsages)
    }
  }

  await recordAssistantExecutionCompletion(context, log, lastUsage)
  return { text: lastText, usage: lastUsage }
}

// ============================================
// Single Prompt Execution (Streaming)
// ============================================

function getPromptRepositoryIds(
  prompt: ChainPrompt,
  context: PromptExecutionContext
): number[] {
  return [
    ...new Set([
      ...(prompt.repositoryIds ?? []),
      ...context.runtimeRepositoryIds,
    ]),
  ]
}

function getPromptRepositoryQuery(
  prompt: ChainPrompt,
  context: PromptExecutionContext
): string {
  return [prompt.content, context.runtimeRepositoryQuery]
    .filter(Boolean)
    .join("\n")
}

/**
 * Build the knowledge context injected ahead of a prompt: repository chunks
 * (hybrid search over the prompt's configured and runtime repository IDs) plus
 * Atrium content-as-context
 * (Phase 6, #1056 — off unless the assistant has a retrieval_scope; skipped when
 * no requester resolved; bounded per hit by the caller's canView). Shared by the
 * streaming and collect-text execution paths; `withEvents` controls the
 * execution-event emission only the streaming path performs.
 */
async function buildPromptKnowledgeContext(
  prompt: ChainPrompt,
  context: PromptExecutionContext,
  requestId: string,
  withEvents: boolean
): Promise<string> {
  let repositoryContext = ""
  const repositoryIds = getPromptRepositoryIds(prompt, context)
  if (repositoryIds.length > 0) {
    if (withEvents) {
      await storeExecutionEvent(context.executionId, "knowledge-retrieval-start", {
        promptId: prompt.id,
        repositories: repositoryIds,
        searchType: "hybrid",
      })
    }

    const knowledgeChunks = await retrieveKnowledgeForPrompt(
      getPromptRepositoryQuery(prompt, context),
      repositoryIds,
      context.userCognitoSub,
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
      if (withEvents) {
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
  }

  const atriumHits = await retrieveAtriumKnowledgeForPrompt(
    context.atriumRequester,
    context.assistantId,
    prompt.content,
    { maxChunks: 10, maxTokens: 4000 },
    requestId
  )
  if (atriumHits.length > 0) {
    repositoryContext += "\n\n" + formatAtriumKnowledgeContext(atriumHits)
  }

  return repositoryContext
}

interface SinglePromptExecutionOptions {
  prompt: ChainPrompt
  inputs: Record<string, unknown>
  context: PromptExecutionContext
  requestId: string
  log: ReturnType<typeof createLogger>
  totalPrompts: number
  isLastPrompt: boolean
  completeExecution?: boolean
  prompts: ChainPrompt[]
}

type PromptUsage = NonNullable<
  Parameters<
    NonNullable<NonNullable<StreamRequest["callbacks"]>["onFinish"]>
  >[0]["usage"]
>

interface PreparedPromptRun {
  prompt: ChainPrompt
  context: PromptExecutionContext
  log: ReturnType<typeof createLogger>
  userMessage: UIMessage
  messages: UIMessage[]
  processedContent: string
  repositoryContext: string
  enabledTools: string[]
  promptTools: NonNullable<StreamRequest["tools"]>
  modelRoute: Awaited<ReturnType<typeof routeAssistantArchitectModel>>
  isLastPrompt: boolean
  completeExecution: boolean
}

async function emitPromptStart(
  options: SinglePromptExecutionOptions
): Promise<void> {
  const { prompt, context, totalPrompts } = options
  await storeExecutionEvent(context.executionId, "prompt-start", {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    totalPrompts,
    modelId: String(prompt.modelId || "unknown"),
    hasKnowledge: getPromptRepositoryIds(prompt, context).length > 0,
    hasTools: !!(prompt.enabledTools && prompt.enabledTools.length > 0),
  })
}

async function preparePromptRun(
  options: SinglePromptExecutionOptions,
  withKnowledgeEvents: boolean
): Promise<PreparedPromptRun> {
  const { prompt, inputs, context, requestId, prompts } = options
  if (!prompt.modelId) {
    throw ErrorFactories.validationFailed([{
      field: "modelId",
      message: `Prompt ${prompt.id} (${prompt.name}) has no model configured`,
    }])
  }
  const repositoryContext = await buildPromptKnowledgeContext(
    prompt,
    context,
    requestId,
    withKnowledgeEvents
  )
  const processedContent = substituteVariables({
    content: prompt.content,
    inputs,
    previousOutputs: context.previousOutputs,
    mapping: (prompt.inputMapping || {}) as Record<string, string>,
    allPrompts: prompts,
    currentPromptPosition: prompt.position,
  })
  const userMessage: UIMessage = {
    id: `prompt-${prompt.id}-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text: processedContent + repositoryContext }],
  }
  const enabledTools = [...(prompt.enabledTools || [])]
  const promptTools = buildPromptRepositoryTools(prompt, context)
  const modelRoute = await routeAssistantArchitectModel({
    text: processedContent,
    userId: context.userId,
    fallbackModelDbId: prompt.modelId,
    routingMode: context.modelRoutingMode,
    requestedFamily: context.modelRoutingFamily,
    requirements: {
      requiredTools: enabledTools,
      requiresFunctionCalling:
        enabledTools.length > 0 || Object.keys(promptTools).length > 0,
    },
  })
  context.modelRoutes.set(prompt.id, modelRoute.metadata)
  return {
    prompt,
    context,
    log: options.log,
    userMessage,
    messages: [...context.accumulatedMessages, userMessage],
    processedContent,
    repositoryContext,
    enabledTools,
    promptTools,
    modelRoute,
    isLastPrompt: options.isLastPrompt,
    completeExecution:
      options.completeExecution ?? options.isLastPrompt,
  }
}

function buildPromptRepositoryTools(
  prompt: ChainPrompt,
  context: PromptExecutionContext
): NonNullable<StreamRequest["tools"]> {
  const repositoryIds = getPromptRepositoryIds(prompt, context)
  if (repositoryIds.length === 0) return {}
  return createRepositoryTools({
    repositoryIds,
    userCognitoSub: context.userCognitoSub,
    assistantOwnerSub: context.assistantOwnerSub,
  }) as NonNullable<StreamRequest["tools"]>
}

function promptStreamRequest(
  run: PreparedPromptRun,
  callbacks: NonNullable<StreamRequest["callbacks"]>
): StreamRequest {
  return {
    messages: run.messages,
    modelId: run.modelRoute.modelId,
    provider: run.modelRoute.provider,
    userId: run.context.userId.toString(),
    sessionId: run.context.userCognitoSub,
    conversationId: undefined,
    source: "assistant_execution",
    timeout: remainingAssistantExecutionTimeoutMs(
      run.context.executionDeadlineAt
    ),
    systemPrompt: run.prompt.systemContext || undefined,
    enabledTools: run.enabledTools,
    tools: Object.keys(run.promptTools).length > 0 ? run.promptTools : undefined,
    callbacks,
  }
}

async function recordPromptCompletion(
  run: PreparedPromptRun,
  text: string,
  usage: PromptUsage | undefined,
  promptStartTime: number,
  promptTimer: ReturnType<typeof startTimer>
): Promise<void> {
  const executionTimeMs = Date.now() - promptStartTime
  promptTimer({ status: "success", tokensUsed: usage?.totalTokens })
  await saveCompletedPromptResult(run, text, executionTimeMs)
  run.context.previousOutputs.set(run.prompt.id, text)
  run.context.accumulatedMessages.push(run.userMessage, {
    id: `assistant-${run.prompt.id}-${Date.now()}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  })
  await storeExecutionEvent(run.context.executionId, "prompt-complete", {
    promptId: run.prompt.id,
    outputTokens: usage?.completionTokens || 0,
    duration: executionTimeMs,
    cached: false,
  }).catch((error) => {
    run.log.error("Failed to store prompt-complete event", { error })
  })
  if (run.completeExecution) {
    await recordAssistantExecutionCompletion(run.context, run.log, usage)
  }
}

async function saveCompletedPromptResult(
  run: PreparedPromptRun,
  text: string,
  executionTimeMs: number
): Promise<void> {
  const startedAt = new Date(Date.now() - executionTimeMs)
  const inputDataJson = JSON.stringify({
    originalContent: run.prompt.content,
    processedContent: run.processedContent,
    repositoryContext: run.repositoryContext ? "included" : "none",
    modelRouting: run.modelRoute.metadata,
  })
  await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, started_at, completed_at, execution_time_ms)
      VALUES (${run.context.executionId}, ${run.prompt.id}, ${inputDataJson}::jsonb, ${text}, 'completed'::execution_status, ${startedAt.toISOString()}::timestamp, ${new Date().toISOString()}::timestamp, ${executionTimeMs})
    `),
    "savePromptResult"
  )
}

async function recordAssistantExecutionCompletion(
  context: PromptExecutionContext,
  log: ReturnType<typeof createLogger>,
  usage?: PromptUsage
): Promise<void> {
  await executeQuery(
    (db) => db.execute(sql`
      UPDATE tool_executions
      SET status = 'completed', completed_at = ${new Date().toISOString()}::timestamp
      WHERE id = ${context.executionId}
    `),
    "updateToolExecutionCompleted"
  )
  await storeExecutionEvent(context.executionId, "execution-complete", {
    executionId: context.executionId,
    totalTokens: usage?.totalTokens || 0,
    duration: Date.now() - context.executionStartTime,
    success: true,
  }).catch((error) => {
    log.error("Failed to store execution-complete event", { error })
  })
}

async function executeSinglePromptWithCompletion(
  options: SinglePromptExecutionOptions
) {
  const { prompt, context, log } = options
  const promptStartTime = Date.now()
  const promptTimer = startTimer(`prompt.${prompt.id}.execution`)
  await emitPromptStart(options)

  try {
    const run = await preparePromptRun(options, true)
    return await streamPromptWithCompletion(run, promptStartTime, promptTimer)
  } catch (promptError) {
    promptTimer({ status: "error" })
    await recordPromptFailure(prompt, context, log, promptError)
    throw promptExecutionError(prompt, promptError)
  }
}

type StreamResult = Awaited<ReturnType<typeof unifiedStreamingService.stream>>

interface CompletedPromptStream {
  streamResponse?: StreamResult
  usage?: PromptUsage
}

function streamPromptWithCompletion(
  run: PreparedPromptRun,
  promptStartTime: number,
  promptTimer: ReturnType<typeof startTimer>
): Promise<CompletedPromptStream> {
  return new Promise((resolve, reject) => {
    let resolveStream!: (value: StreamResult) => void
    let rejectStream!: (error: Error) => void
    const streamResponse = new Promise<StreamResult>((resolveResponse, rejectResponse) => {
      resolveStream = resolveResponse
      rejectStream = rejectResponse
    })
    const request = promptStreamRequest(run, {
      onFinish: async ({ text, usage }) => {
        try {
          await recordPromptCompletion(
            run,
            text || "",
            usage,
            promptStartTime,
            promptTimer
          )
          resolve({
            streamResponse: run.isLastPrompt
              ? await streamResponse
              : undefined,
            usage,
          })
        } catch (error) {
          run.log.error("Failed to save prompt result", {
            error,
            promptId: run.prompt.id,
            executionId: run.context.executionId,
          })
          reject(error)
        }
      },
      onError: (error) => {
        promptTimer({ status: "error" })
        reject(error)
      },
    })
    void startPromptStream(request, promptTimer, resolveStream, rejectStream, reject)
  })
}

async function startPromptStream(
  request: StreamRequest,
  promptTimer: ReturnType<typeof startTimer>,
  resolveStream: (value: StreamResult) => void,
  rejectStream: (error: Error) => void,
  rejectExecution: (error: unknown) => void
): Promise<void> {
  try {
    resolveStream(await unifiedStreamingService.stream(request))
  } catch (error) {
    promptTimer({ status: "error" })
    const streamError = error instanceof Error ? error : new Error(String(error))
    rejectStream(streamError)
    rejectExecution(error)
  }
}

async function recordPromptFailure(
  prompt: ChainPrompt,
  context: PromptExecutionContext,
  log: ReturnType<typeof createLogger>,
  error: unknown
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  await storeExecutionEvent(context.executionId, "execution-error", {
    executionId: context.executionId,
    error: errorMessage,
    promptId: prompt.id,
    recoverable: false,
  }).catch((eventError) => {
    log.error("Failed to store prompt error event", { error: eventError })
  })
  const now = new Date()
  const failedInputJson = JSON.stringify({ prompt: prompt.content })
  await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, error_message, started_at, completed_at)
      VALUES (${context.executionId}, ${prompt.id}, ${failedInputJson}::jsonb, '', 'failed'::execution_status, ${errorMessage}, ${now.toISOString()}::timestamp, ${now.toISOString()}::timestamp)
    `),
    "saveFailedPromptResult"
  )
}

function promptExecutionError(prompt: ChainPrompt, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return ErrorFactories.sysInternalError(
    `Prompt ${prompt.id} (${prompt.name}) failed: ${message}`,
    { cause: error instanceof Error ? error : undefined }
  )
}

// ============================================
// Single Prompt Execution (Text Collection)
// ============================================

async function executeSinglePromptCollectText(
  options: SinglePromptExecutionOptions
): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const { prompt } = options
  const promptStartTime = Date.now()
  const promptTimer = startTimer(`prompt.${prompt.id}.execution`)
  await emitPromptStart(options)

  try {
    const run = await preparePromptRun(options, false)
    return await collectPromptText(run, promptStartTime, promptTimer)
  } catch (promptError) {
    promptTimer({ status: "error" })
    throw promptExecutionError(prompt, promptError)
  }
}

interface CollectedPromptText {
  text: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

function collectPromptText(
  run: PreparedPromptRun,
  promptStartTime: number,
  promptTimer: ReturnType<typeof startTimer>
): Promise<CollectedPromptText> {
  return new Promise((resolve, reject) => {
    const request = promptStreamRequest(run, {
      onFinish: async ({ text, usage }) => {
        try {
          const output = text || ""
          await recordPromptCompletion(
            run,
            output,
            usage,
            promptStartTime,
            promptTimer
          )
          resolve({ text: output, usage: publicPromptUsage(usage) })
        } catch (error) {
          reject(error)
        }
      },
      onError: (error) => {
        promptTimer({ status: "error" })
        reject(error)
      },
    })
    void unifiedStreamingService.stream(request).catch((error) => {
      promptTimer({ status: "error" })
      reject(error)
    })
  })
}

function publicPromptUsage(
  usage?: PromptUsage
): CollectedPromptText["usage"] {
  return usage
    ? {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      }
    : undefined
}

function aggregatePromptUsage(
  usages: Array<
    | {
        promptTokens: number
        completionTokens: number
        totalTokens: number
      }
    | undefined
  >
): CollectedPromptText["usage"] {
  const reported = usages.filter(
    (
      usage
    ): usage is {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    } => usage !== undefined
  )
  if (reported.length === 0) return undefined
  return reported.reduce(
    (total, usage) => ({
      promptTokens: total.promptTokens + usage.promptTokens,
      completionTokens:
        total.completionTokens + usage.completionTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  )
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

// Exported for unit testing (REV-COR-517).
export function substituteVariables(
  options: {
    content: string
    inputs: Record<string, unknown>
    previousOutputs: Map<number, string>
    mapping: Record<string, string>
    allPrompts: ChainPrompt[]
    currentPromptPosition: number
  }
): string {
  const {
    content,
    inputs,
    previousOutputs,
    mapping,
    allPrompts,
    currentPromptPosition,
  } = options
  if (content.length > MAX_PROMPT_CONTENT_SIZE) {
    throw ErrorFactories.validationFailed([{
      field: "content",
      message: `Prompt content exceeds maximum size of ${MAX_PROMPT_CONTENT_SIZE} characters`,
    }])
  }

  // Decode MDXEditor escapes (\$ \{ \_ &#x24; &amp;#x24;) so the variable regex can match stored content.
  const decoded = decodeMdxEditorEscapes(content)

  // Updated regex: [\w-]+ to match hyphenated slugified names (regression from #685)
  const placeholderMatches = decoded.match(/\${([\w-]+)}|{{([\w-]+)}}/g)
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
    .sort(compareAssistantPromptExecutionOrder)

  for (const [i, prevPrompt] of sortedPrevPrompts.entries()) {
    const output = previousOutputs.get(prevPrompt.id)
    // Always map position → prompt ID for prompt_N_output (even if no output yet)
    positionToPromptId.set(i, prevPrompt.id)
    if (output !== undefined) {
      // Map slugified name → output (e.g., "facilitator-opening" → output text)
      const slug = slugify(prevPrompt.name)
      // Handle duplicate/empty slugs by appending prompt ID for uniqueness
      const uniqueKey = slug || `prompt-${prevPrompt.id}`
      slugifiedOutputs.set(uniqueKey, output)
    }
  }

  return decoded.replace(/\${([\w-]+)}|{{([\w-]+)}}/g, (match, dollarVar, braceVar) => {
    const varName = dollarVar || braceVar

    // Path 1: Explicit inputMapping (backward compatible). Guard with Object.hasOwn
    // so a placeholder naming an inherited member (${constructor}) does not read
    // Object.prototype.constructor off the mapping and fire this branch (REV-COR-517).
    if (Object.hasOwn(mapping, varName) && mapping[varName]) {
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

    // Path 2: User input fields. Use Object.hasOwn (not `in`, which walks the
    // prototype chain) so placeholders naming inherited Object.prototype members
    // (${constructor}, ${toString}, …) are treated as unknown and left literal
    // (REV-COR-517).
    if (Object.hasOwn(inputs, varName)) {
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
    // Guard with Object.hasOwn so a mapping path (e.g. inputs.constructor,
    // previousOutputs.__proto__) cannot traverse into an inherited prototype
    // member (REV-COR-517).
    if (current && typeof current === "object" && Object.hasOwn(current, part)) {
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
