import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { getChainPromptById, getAIModelById, getActiveAIModels } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId();
  const timer = startTimer("api.assistant-architect.prompts.get");
  const log = createLogger({ requestId, route: "api.assistant-architect.prompts" });
  
  log.info("GET /api/assistant-architect/prompts/[id] - Fetching prompt");
  
  // Check authentication
  const session = await getServerSession()
  if (!session || !session.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse("Unauthorized", { status: 401, headers: { "X-Request-Id": requestId } })
  }

  try {
    // Await params for Next.js 15 dynamic API routes
    const resolvedParams = await params
    const promptId = resolvedParams.id

    // Parse promptId to integer
    const promptIdInt = Number.parseInt(promptId, 10)
    if (Number.isNaN(promptIdInt)) {
      log.warn("Invalid prompt ID", { promptId });
      timer({ status: "error", reason: "invalid_id" });
      return new NextResponse("Invalid prompt ID", { status: 400, headers: { "X-Request-Id": requestId } })
    }

    // Find the prompt by ID
    const prompt = await getChainPromptById(promptIdInt)

    if (!prompt) {
      log.warn("Prompt not found", { promptId: promptIdInt });
      timer({ status: "error", reason: "not_found" });
      return new NextResponse("Prompt not found", { status: 404, headers: { "X-Request-Id": requestId } })
    }
    let actualModelId: string | null = null;

    // If the prompt has a model ID integer reference, fetch the corresponding AI model's text model_id
    if (prompt.modelId) {
      const model = await getAIModelById(prompt.modelId)
      if (model) {
        actualModelId = model.modelId // Get the text model_id
      }
    }

    // If no model found through the prompt, get the text model_id of the first available model
    if (!actualModelId) {
      const activeModels = await getActiveAIModels()
      actualModelId = activeModels[0]?.modelId || null
    }

    // Return the prompt along with the actual text model_id
    log.info("Prompt fetched successfully", { promptId: promptIdInt });
    timer({ status: "success" });

    return NextResponse.json({
      id: prompt.id,
      toolId: prompt.assistantArchitectId,
      name: prompt.name,
      content: prompt.content,
      systemContext: prompt.systemContext,
      modelId: prompt.modelId,
      position: prompt.position,
      inputMapping: prompt.inputMapping,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
      actualModelId: actualModelId // Send the text model_id
    }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching prompt", error)
    return new NextResponse(
      JSON.stringify({ error: "Failed to fetch prompt" }),
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 