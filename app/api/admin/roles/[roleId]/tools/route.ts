import { NextRequest, NextResponse } from "next/server"
import { getRoleTools } from "@/lib/db/drizzle"
import { requireAdmin } from "@/lib/auth/admin-check"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getErrorMessage } from "@/types/errors";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.tools.list");
  const log = createLogger({ requestId, route: "api.admin.roles.tools" });
  
  log.info("GET /api/admin/roles/[roleId]/tools - Fetching role tools");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const { roleId } = await params
    log.debug("Fetching tools for role", { roleId });
    const tools = await getRoleTools(Number.parseInt(roleId, 10))
    
    log.info("Role tools fetched successfully", { roleId, toolCount: tools.length });
    timer({ status: "success", count: tools.length });
    return NextResponse.json({ tools }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching role tools", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to fetch role tools" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 