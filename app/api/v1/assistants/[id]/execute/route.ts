/**
 * Assistant Execution Endpoint
 * POST /api/v1/assistants/:id/execute — Execute an assistant
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 *
 * Supports two response modes via Accept header:
 * - text/event-stream (default) → SSE streaming response
 * - application/json → 202 Accepted with jobId for async polling
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  extractNumericParam,
  verifyAssistantAccess,
  parseRequestBody,
  isErrorResponse,
  type ApiAuthContext,
} from "@/lib/api"
import {
  executeAssistant,
  executeAssistantForJobCompletion,
  validateExecutionInputs,
  isContentSafetyBlocked,
} from "@/lib/api/assistant-execution-service"
import { jobManagementService } from "@/lib/streaming/job-management-service"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { createLogger, startTimer } from "@/lib/logger"

// Allow streaming responses up to 15 minutes for long chains
export const maxDuration = 900

// ============================================
// Validation
// ============================================

const executeBodySchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
})

const EXECUTE_TOOL_IDENTIFIER = "assistants.execute"

/**
 * Gate execution on the tool catalog (single source of truth — issue #924 AC
 * #4/#7) and scope. Two checks, in order:
 *
 *  1. Active state. The catalog row for `assistants.execute` carries an
 *     `is_active` flag an admin can flip in the DB control plane. The MCP
 *     surface enforces this via `ToolCatalog.dispatch()`, but this REST route
 *     calls `executeAssistant()` directly, so it must re-check `isActive` itself
 *     (the catalog `get()` returns inactive entries by design). Without this,
 *     disabling the tool would silently block MCP yet leave REST callable —
 *     a deceptive admin control. Returns 404 (not 403) so a disabled tool is
 *     indistinguishable from a non-existent one and does not leak its state.
 *  2. Scope. The per-assistant `assistant:{id}:execute` variant short-circuits
 *     first (avoids a spurious requireScope denial log). Otherwise every REST
 *     scope the catalog declares must be held (all-of semantics) — the literal
 *     fallback is only used if the tool is absent from the catalog (e.g. a DB
 *     outage that also lost the manifest projection).
 *
 * Returns a NextResponse to short-circuit (403/404), or null if allowed.
 */
async function requireExecuteScope(
  auth: ApiAuthContext,
  assistantId: number,
  requestId: string
): Promise<NextResponse | null> {
  // Active-state gate. If the tool is cataloged but disabled, deny regardless of
  // scope. An absent entry (undefined) means the catalog could not resolve it;
  // fall through to the scope check, whose literal fallback still enforces auth.
  const entry = await toolCatalogInstance.get(EXECUTE_TOOL_IDENTIFIER)
  if (entry && !entry.isActive) {
    return createErrorResponse(requestId, 404, "NOT_FOUND", "Assistant execution is not available")
  }

  if (auth.scopes.includes(`assistant:${assistantId}:execute`)) return null

  // The REST surface may declare more than one required scope (all-of semantics).
  // requireScope only checks a single scope, so enforce every returned scope —
  // indexing [0] would silently drop any additional required scopes.
  const restScopes = entry
    ? await toolCatalogInstance.getRequiredScopes(EXECUTE_TOOL_IDENTIFIER, "rest")
    : undefined
  const scopesToCheck = restScopes?.length ? restScopes : ["assistants:execute"]
  for (const scope of scopesToCheck) {
    const scopeError = requireScope(auth, scope, requestId)
    if (scopeError) return scopeError
  }
  return null
}

// ============================================
// POST — Execute Assistant
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.assistants.execute" })

  // 1. Extract assistant ID from URL
  const assistantId = extractNumericParam(request.url, "assistants")
  if (!assistantId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID")
  }

  // 2. Check scope (catalog-resolved REST scope or per-assistant variant).
  const scopeError = await requireExecuteScope(auth, assistantId, requestId)
  if (scopeError) return scopeError

  // 3. Verify assistant exists and user has access
  const accessError = await verifyAssistantAccess(assistantId, auth, requestId)
  if (accessError) return accessError

  // 4. Parse and validate request body
  const result = await parseRequestBody(request, executeBodySchema, requestId)
  if (isErrorResponse(result)) return result
  const { inputs } = result.data

  // Validate input sizes
  const inputErrors = validateExecutionInputs(inputs)
  if (inputErrors) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid inputs", inputErrors)
  }

  // 5. Determine response mode
  const acceptHeader = request.headers.get("accept") || ""
  const wantsJson = acceptHeader.includes("application/json") && !acceptHeader.includes("text/event-stream")

  log.info("Executing assistant", {
    assistantId,
    userId: auth.userId,
    mode: wantsJson ? "async" : "stream",
    inputKeys: Object.keys(inputs),
  })

  try {
    if (wantsJson) {
      // Async mode: return 202 with job ID, execute in background
      return await handleAsyncExecution(assistantId, inputs, auth, requestId, log)
    }

    // Streaming mode: return SSE response
    const execResult = await executeAssistant({
      assistantId,
      inputs,
      userId: auth.userId,
      cognitoSub: auth.cognitoSub,
      requestId,
    })

    // Cast to NextResponse — streaming Response is compatible at runtime
    return new NextResponse(execResult.streamResponse.body, {
      status: execResult.streamResponse.status,
      headers: Object.fromEntries(execResult.streamResponse.headers.entries()),
    })
  } catch (error) {
    if (isContentSafetyBlocked(error)) {
      return createErrorResponse(requestId, 400, "CONTENT_BLOCKED", error.message, {
        categories: error.blockedCategories,
        source: error.source,
      })
    }

    log.error("Assistant execution failed", {
      error: error instanceof Error ? error.message : String(error),
      assistantId,
    })
    return createErrorResponse(requestId, 500, "EXECUTION_ERROR", "Assistant execution failed")
  }
})

// ============================================
// Async Execution Handler
// ============================================

async function handleAsyncExecution(
  assistantId: number,
  inputs: Record<string, unknown>,
  auth: { userId: number; cognitoSub: string },
  requestId: string,
  log: ReturnType<typeof createLogger>
) {
  // Create a job record
  const jobId = await jobManagementService.createJob({
    conversationId: `assistant-exec-${assistantId}-${Date.now()}`,
    userId: auth.userId,
    modelId: 0, // Will be determined during execution
    modelIdString: "pending",
    messages: [],
    provider: "assistant-architect",
    systemPrompt: undefined,
    options: {},
    source: "assistant_execution",
    toolMetadata: {
      toolId: assistantId,
      executionId: 0,
      prompts: [],
      inputMapping: {},
    },
  })

  log.info("Created async job for assistant execution", { jobId, assistantId })

  // Execute in background with error monitoring
  const jobTimer = startTimer("background_job_execution")

  void (async () => {
    try {
      const result = await executeAssistantForJobCompletion({
        assistantId,
        inputs,
        userId: auth.userId,
        cognitoSub: auth.cognitoSub,
        requestId,
      })

      await jobManagementService.completeJob(jobId, {
        text: result.text,
        usage: result.usage ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        } : undefined,
        finishReason: "stop",
      })

      jobTimer({ status: "success", assistantId: String(assistantId) })
      log.info("Async assistant execution completed", { jobId, assistantId })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)

      try {
        await jobManagementService.failJob(jobId, errMsg)
      } catch (failJobError) {
        // Critical: if we can't mark the job as failed, it will be stuck in pending
        log.error("CRITICAL: Failed to mark job as failed — job stuck in pending", {
          jobId,
          originalError: errMsg,
          failJobError: failJobError instanceof Error ? failJobError.message : String(failJobError),
        })
      }

      jobTimer({ status: "error", assistantId: String(assistantId) })
      log.error("Async assistant execution failed", {
        jobId,
        assistantId,
        error: errMsg,
        userId: auth.userId,
      })
    }
  })()

  return createApiResponse(
    {
      data: {
        jobId,
        status: "pending",
        pollUrl: `/api/v1/jobs/${jobId}`,
      },
      meta: { requestId },
    },
    requestId,
    202
  )
}
