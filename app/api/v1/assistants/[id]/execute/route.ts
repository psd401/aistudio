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
  requireAssistantScope,
  createApiResponse,
  createErrorResponse,
  extractNumericParam,
  verifyAssistantAccess,
  parseRequestBody,
  isErrorResponse,
} from "@/lib/api"
import {
  executeAssistant,
  executeAssistantForJobCompletion,
  validateExecutionInputs,
  isContentSafetyBlocked,
} from "@/lib/api/assistant-execution-service"
import { jobManagementService } from "@/lib/streaming/job-management-service"
import { createLogger, startTimer } from "@/lib/logger"

// Allow streaming responses up to 15 minutes for long chains
export const maxDuration = 900

// ============================================
// Validation
// ============================================

const executeBodySchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
})

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

  // 2. Check scope (assistants:execute or assistant:{id}:execute)
  const scopeError = requireAssistantScope(auth, assistantId, requestId)
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
