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
} from "@/lib/api"
import {
  getAssistantForAccessCheck,
  validateAssistantAccess,
} from "@/lib/api/assistant-service"
import {
  executeAssistant,
  executeAssistantForJobCompletion,
  validateExecutionInputs,
  isContentSafetyBlocked,
} from "@/lib/api/assistant-execution-service"
import { hasRole } from "@/utils/roles"
import { jobManagementService } from "@/lib/streaming/job-management-service"
import { createLogger } from "@/lib/logger"

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
  const assistantId = extractAssistantId(request.url)
  if (!assistantId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID")
  }

  // 2. Check scope (assistants:execute or assistant:{id}:execute)
  const scopeError = requireAssistantScope(auth, assistantId, requestId)
  if (scopeError) return scopeError

  // 3. Verify assistant exists and user has access
  const accessRow = await getAssistantForAccessCheck(assistantId)
  if (!accessRow) {
    return createErrorResponse(requestId, 404, "NOT_FOUND", `Assistant not found: ${assistantId}`)
  }

  const isAdmin = await hasRole("administrator")
  const access = validateAssistantAccess(accessRow, auth.userId, isAdmin)
  if (!access.allowed) {
    return createErrorResponse(requestId, 404, "NOT_FOUND", `Assistant not found: ${assistantId}`)
  }

  // 4. Parse and validate request body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createErrorResponse(requestId, 400, "INVALID_JSON", "Request body must be valid JSON")
  }

  const parsed = executeBodySchema.safeParse(body)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.issues)
  }

  const { inputs } = parsed.data

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
    const result = await executeAssistant({
      assistantId,
      inputs,
      userId: auth.userId,
      cognitoSub: auth.cognitoSub,
      requestId,
    })

    // Cast to NextResponse — streaming Response is compatible at runtime
    return new NextResponse(result.streamResponse.body, {
      status: result.streamResponse.status,
      headers: Object.fromEntries(result.streamResponse.headers.entries()),
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

  // Fire-and-forget: execute in background
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

      log.info("Async assistant execution completed", { jobId, assistantId })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      await jobManagementService.failJob(jobId, errMsg).catch((e) =>
        log.error("Failed to mark job as failed", { jobId, error: e })
      )
      log.error("Async assistant execution failed", { jobId, assistantId, error: errMsg })
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

// ============================================
// URL Helper
// ============================================

function extractAssistantId(url: string): number | null {
  const segments = new URL(url).pathname.split("/")
  const assistantsIdx = segments.indexOf("assistants")
  const idStr = segments[assistantsIdx + 1]
  if (!idStr) return null
  const id = Number.parseInt(idStr, 10)
  return Number.isNaN(id) || id <= 0 ? null : id
}
