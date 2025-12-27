import { NextResponse } from "next/server"
import { getAssistantArchitectsAction } from "@/actions/db/assistant-architect-actions"
import { getServerSession } from "@/lib/auth/server-session"
import { hasToolAccess } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export const dynamic = 'force-dynamic'

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.assistant-architects.list");
  const log = createLogger({ requestId, route: "api.assistant-architects" });
  
  log.info("GET /api/assistant-architects - Fetching assistant architects");
  
  try {
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized - No session or sub");
      timer({ status: "error", reason: "unauthorized" });
      return NextResponse.json(
        { isSuccess: false, message: "Unauthorized" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }

    // Check if user has access to the assistant-architect tool
    const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
    if (!hasAccess) {
      log.warn("Forbidden - User lacks assistant-architect access");
      timer({ status: "error", reason: "forbidden" });
      return NextResponse.json(
        { isSuccess: false, message: "Forbidden" },
        { status: 403, headers: { "X-Request-Id": requestId } }
      )
    }
    
    const result = await getAssistantArchitectsAction()
    
    if (!result.isSuccess) {
      log.warn("Failed to get assistant architects", { message: result.message });
      timer({ status: "error", reason: "fetch_failed" });
      return NextResponse.json(result, { status: 400, headers: { "X-Request-Id": requestId } })
    }

    log.info("Assistant architects fetched successfully", { count: result.data?.length || 0 });
    timer({ status: "success", count: result.data?.length || 0 });
    
    return NextResponse.json({
      tools: result.data
    }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error in assistant-architects API", error)
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: "Failed to fetch Assistant Architects"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 