import { NextRequest, NextResponse } from "next/server"
import { assignToolToRole, removeToolFromRole } from "@/lib/db/drizzle"
import { requireAdmin } from "@/lib/auth/admin-check"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getErrorMessage } from "@/types/errors";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string; toolId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.tools.assign");
  const log = createLogger({ requestId, route: "api.admin.roles.tools" });
  
  log.info("POST /api/admin/roles/[roleId]/tools/[toolId] - Assigning tool to role");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const { roleId, toolId } = await params
    log.debug("Assigning tool to role", { roleId, toolId });
    const success = await assignToolToRole(Number.parseInt(roleId), Number.parseInt(toolId))
    
    log.info("Tool assigned to role successfully", { roleId, toolId });
    timer({ status: "success" });
    return NextResponse.json({ success }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error assigning tool to role", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to assign tool" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string; toolId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.tools.remove");
  const log = createLogger({ requestId, route: "api.admin.roles.tools" });
  
  log.info("DELETE /api/admin/roles/[roleId]/tools/[toolId] - Removing tool from role");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const { roleId, toolId } = await params
    log.debug("Removing tool from role", { roleId, toolId });
    const success = await removeToolFromRole(Number.parseInt(roleId), Number.parseInt(toolId))
    
    log.info("Tool removed from role successfully", { roleId, toolId });
    timer({ status: "success" });
    return NextResponse.json({ success }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error removing tool from role", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to remove tool" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 