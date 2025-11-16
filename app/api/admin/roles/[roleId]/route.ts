import { NextRequest, NextResponse } from "next/server"
import { updateRole, deleteRole } from "@/lib/db/data-api-adapter"
import { requireAdmin } from "@/lib/auth/admin-check"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { getErrorMessage } from "@/types/errors"

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.update");
  const log = createLogger({ requestId, route: "api.admin.roles" });
  
  log.info("PUT /api/admin/roles/[roleId] - Updating role");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const { roleId } = await params
    const body = await request.json()
    log.debug("Updating role", { roleId, updates: body });
    const role = await updateRole(Number.parseInt(roleId), body)
    
    log.info("Role updated successfully", { roleId });
    timer({ status: "success" });
    return NextResponse.json({ role }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error updating role", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to update role" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.delete");
  const log = createLogger({ requestId, route: "api.admin.roles" });
  
  log.info("DELETE /api/admin/roles/[roleId] - Deleting role");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const { roleId } = await params
    log.debug("Deleting role", { roleId });
    const role = await deleteRole(Number.parseInt(roleId))
    
    log.info("Role deleted successfully", { roleId });
    timer({ status: "success" });
    return NextResponse.json({ role }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error deleting role", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to delete role" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 