import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { getModelConfig } from "@/lib/ai/model-config"
import { getServerSession } from "@/lib/auth/server-session"
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { unifiedStreamingService } from "@/lib/streaming/unified-streaming-service"
import type { StreamRequest } from "@/lib/streaming/types"
import type { UIMessage } from "ai"

export const maxDuration = 30

const MAX_PROMPT_LENGTH = 10_000
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. Please provide a clear and concise response."

interface ComparisonInput {
  model1Id: string | number
  model1Name?: string
  model2Id: string | number
  model2Name?: string
  prompt: string
}

type ParseResult =
  | { ok: true; input: ComparisonInput }
  | { ok: false; response: Response }

type ConfiguredModel = NonNullable<Awaited<ReturnType<typeof getModelConfig>>>
type RouteLogger = ReturnType<typeof createLogger>
type RouteTimer = ReturnType<typeof startTimer>
type ModelKey = "model1" | "model2"

interface CompletionState {
  closed: boolean
  model1: boolean
  model2: boolean
}

interface StreamRequestOptions {
  completion: CompletionState
  controller: ReadableStreamDefaultController<Uint8Array>
  log: RouteLogger
  messages: UIMessage[]
  model: ConfiguredModel
  modelKey: ModelKey
  sendData: (data: Record<string, unknown>) => void
  sessionId: string
  userId: string
}

interface RunModelStreamOptions {
  completion: CompletionState
  controller: ReadableStreamDefaultController<Uint8Array>
  log: RouteLogger
  modelKey: ModelKey
  request: StreamRequest
  sendData: (data: Record<string, unknown>) => void
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function isValidModelId(id: unknown): id is string | number {
  return (
    (typeof id === "string" && id.trim().length > 0) ||
    (typeof id === "number" && !Number.isNaN(id) && id > 0)
  )
}

async function parseComparisonInput(req: Request): Promise<ParseResult> {
  const body = (await req.json()) as Record<string, unknown>
  const { prompt, model1Id, model2Id, model1Name, model2Name } = body

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { ok: false, response: jsonError("Invalid prompt", 400) }
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, response: jsonError("Prompt too long", 400) }
  }
  if (!isValidModelId(model1Id) || !isValidModelId(model2Id)) {
    return { ok: false, response: jsonError("Invalid model ID", 400) }
  }
  if (model1Name !== undefined && typeof model1Name !== "string") {
    return { ok: false, response: jsonError("Invalid model name", 400) }
  }
  if (model2Name !== undefined && typeof model2Name !== "string") {
    return { ok: false, response: jsonError("Invalid model name", 400) }
  }

  return {
    ok: true,
    input: { prompt, model1Id, model2Id, model1Name, model2Name },
  }
}

function markComplete(
  modelKey: ModelKey,
  completion: CompletionState,
  sendData: (data: Record<string, unknown>) => void,
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  completion[modelKey] = true
  if (!completion.model1 || !completion.model2 || completion.closed) return

  completion.closed = true
  sendData({ done: true })
  controller.close()
}

function createStreamRequest(options: StreamRequestOptions): StreamRequest {
  const {
    completion,
    controller,
    log,
    messages,
    model,
    modelKey,
    sendData,
    sessionId,
    userId,
  } = options
  const modelNumber = modelKey === "model1" ? "1" : "2"

  return {
    messages,
    modelId: model.model_id,
    provider: model.provider,
    userId,
    sessionId,
    source: "compare",
    systemPrompt: SYSTEM_PROMPT,
    callbacks: {
      onProgress: (event) => {
        if (event.type === "token" && event.text) {
          sendData({ [modelKey]: event.text })
        }
      },
      onFinish: async ({ usage }) => {
        log.info(`Model ${modelNumber} completed`, {
          modelId: model.model_id,
          tokensUsed: usage?.totalTokens,
        })
        sendData({ [`${modelKey}Finished`]: true })
        markComplete(modelKey, completion, sendData, controller)
      },
      onError: (error) => {
        log.error(`Model ${modelNumber} error`, { error: error.message })
        sendData({ [`${modelKey}Error`]: error.message })
        markComplete(modelKey, completion, sendData, controller)
      },
    },
  }
}

async function runModelStream(
  options: RunModelStreamOptions
): Promise<void> {
  try {
    await unifiedStreamingService.stream(options.request)
  } catch (error) {
    options.log.error(`Failed to stream ${options.modelKey}`, { error })
    options.sendData({
      [`${options.modelKey}Error`]: "Failed to stream response",
    })
    markComplete(
      options.modelKey,
      options.completion,
      options.sendData,
      options.controller
    )
  }
}

interface ComparisonStreamOptions {
  log: RouteLogger
  messages: UIMessage[]
  model1: ConfiguredModel
  model2: ConfiguredModel
  sessionId: string
  timer: RouteTimer
  userId: string
}

function createComparisonStream(options: ComparisonStreamOptions) {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const completion: CompletionState = {
        closed: false,
        model1: false,
        model2: false,
      }
      const sendData = (data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        )
      }

      try {
        const shared = {
          completion,
          controller,
          log: options.log,
          messages: options.messages,
          sendData,
          sessionId: options.sessionId,
          userId: options.userId,
        }
        const request1 = createStreamRequest({
          ...shared,
          model: options.model1,
          modelKey: "model1",
        })
        const request2 = createStreamRequest({
          ...shared,
          model: options.model2,
          modelKey: "model2",
        })

        options.log.info("Starting parallel streams")
        await Promise.all([
          runModelStream({
            completion,
            controller,
            log: options.log,
            modelKey: "model1",
            request: request1,
            sendData,
          }),
          runModelStream({
            completion,
            controller,
            log: options.log,
            modelKey: "model2",
            request: request2,
            sendData,
          }),
        ])
        options.timer({ status: "success" })
      } catch (error) {
        options.log.error("Stream error", { error })
        controller.error(error)
        options.timer({ status: "error" })
      }
    },
  })
}

export async function POST(req: Request) {
  const requestId = generateRequestId()
  const timer = startTimer("api.compare-models")
  const log = createLogger({ requestId, route: "api.compare-models" })

  log.info("POST /api/compare-models - Processing comparison request")

  try {
    const parsed = await parseComparisonInput(req)
    if (!parsed.ok) return parsed.response

    const session = await getServerSession()
    if (!session) {
      timer({ status: "error", reason: "unauthorized" })
      return new Response("Unauthorized", { status: 401 })
    }

    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      return new Response("Unauthorized", { status: 401 })
    }

    const [model1, model2] = await Promise.all([
      getModelConfig(parsed.input.model1Id),
      getModelConfig(parsed.input.model2Id),
    ])
    if (!model1 || !model2) {
      return jsonError("One or both models not found", 404)
    }

    const accessibleIds = await filterAccessibleResourceIds(
      currentUser.data.user.id,
      "model",
      [model1.id, model2.id]
    )
    const model1Allowed = accessibleIds.has(String(model1.id))
    const model2Allowed = accessibleIds.has(String(model2.id))
    if (!model1Allowed || !model2Allowed) {
      log.warn("Forbidden model in comparison", {
        userId: currentUser.data.user.id,
        model1Allowed,
        model2Allowed,
      })
      return jsonError(
        "You do not have access to one or both selected models",
        403
      )
    }

    const messages: UIMessage[] = [
      {
        id: generateRequestId(),
        role: "user",
        parts: [{ type: "text", text: parsed.input.prompt }],
      },
    ]
    const stream = createComparisonStream({
      log,
      messages,
      model1,
      model2,
      sessionId: session.sub,
      timer,
      userId: currentUser.data.user.id.toString(),
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
        "X-Unified-Streaming": "true",
      },
    })
  } catch (error) {
    log.error("Compare API error", {
      error:
        error instanceof Error
          ? { message: error.message, name: error.name, stack: error.stack }
          : String(error),
    })
    timer({ status: "error" })
    return new Response(
      JSON.stringify({
        error: "Failed to process comparison request",
        requestId,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        },
      }
    )
  }
}
