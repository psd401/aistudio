import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
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
    if (isNaN(promptIdInt)) {
      log.warn("Invalid prompt ID", { promptId });
      timer({ status: "error", reason: "invalid_id" });
      return new NextResponse("Invalid prompt ID", { status: 400, headers: { "X-Request-Id": requestId } })
    }

    // Find the prompt by ID
    const promptSql = `
      SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, created_at, updated_at
      FROM chain_prompts
      WHERE id = :promptId
    `
    const promptResult = await executeSQL(promptSql, [
      { name: 'promptId', value: { longValue: promptIdInt } }
    ])

    if (!promptResult || promptResult.length === 0) {
      log.warn("Prompt not found", { promptId: promptIdInt });
      timer({ status: "error", reason: "not_found" });
      return new NextResponse("Prompt not found", { status: 404, headers: { "X-Request-Id": requestId } })
    }

    const prompt = promptResult[0]
    let actualModelId: string | null = null;

    // If the prompt has a model ID integer reference, fetch the corresponding AI model's text model_id
    if (prompt.model_id) {
      const modelSql = `
        SELECT id, model_id
        FROM ai_models
        WHERE id = :modelId
      `
      const modelResult = await executeSQL(modelSql, [
        { name: 'modelId', value: { longValue: Number(prompt.model_id) } }
      ])

      if (modelResult && modelResult.length > 0) {
        actualModelId = String(modelResult[0].model_id); // Get the text model_id
      }
    }

    // If no model found through the prompt, get the text model_id of the first available model
    if (!actualModelId) {
      const defaultModelSql = `
        SELECT model_id
        FROM ai_models
        WHERE active = true
        LIMIT 1
      `
      const defaultModelResult = await executeSQL(defaultModelSql)
      
      actualModelId = defaultModelResult?.[0]?.model_id ? String(defaultModelResult[0].model_id) : null;
    }

    // Transform snake_case to camelCase and return the prompt along with the actual text model_id
    log.info("Prompt fetched successfully", { promptId: promptIdInt });
    timer({ status: "success" });
    
    return NextResponse.json({
      id: prompt.id,
      toolId: prompt.assistant_architect_id,
      name: prompt.name,
      content: prompt.content,
      systemContext: prompt.system_context,
      modelId: prompt.model_id,
      position: prompt.position,
      inputMapping: prompt.input_mapping,
      createdAt: prompt.created_at,
      updatedAt: prompt.updated_at,
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