import { NextRequest, NextResponse } from "next/server"
import { assignCapabilityToRole, removeCapabilityFromRole } from "@/lib/db/drizzle"
import { requireAdmin } from "@/lib/auth/admin-check"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getErrorMessage } from "@/types/errors";

/**
 * Route path preserves the legacy `/tools/[toolId]` segment for client backward
 * compatibility. `toolId` carries a capability ID since the tools -> capabilities
 * migration (#928); do not "fix" the path or param name.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string; toolId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.tools.assign");
  const log = createLogger({ requestId, route: "api.admin.roles.tools" });
  
  log.info("POST /api/admin/roles/[roleId]/tools/[toolId] - Assigning capability to role");

  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // The route param is named toolId for backwards-compatible URLs, but it now
    // carries a capability id (tools -> capabilities migration, #928).
    const { roleId, toolId: capabilityId } = await params
    log.debug("Assigning capability to role", { roleId, capabilityId });
    const success = await assignCapabilityToRole(Number.parseInt(roleId), Number.parseInt(capabilityId))

    log.info("Capability assigned to role successfully", { roleId, capabilityId });
    timer({ status: "success" });
    return NextResponse.json({ success }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error assigning capability to role", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to assign capability" },
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
  
  log.info("DELETE /api/admin/roles/[roleId]/tools/[toolId] - Removing capability from role");

  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // The route param is named toolId for backwards-compatible URLs, but it now
    // carries a capability id (tools -> capabilities migration, #928).
    const { roleId, toolId: capabilityId } = await params
    log.debug("Removing capability from role", { roleId, capabilityId });
    const success = await removeCapabilityFromRole(Number.parseInt(roleId), Number.parseInt(capabilityId))

    log.info("Capability removed from role successfully", { roleId, capabilityId });
    timer({ status: "success" });
    return NextResponse.json({ success }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error removing capability from role", error)
    return NextResponse.json(
      { error: getErrorMessage(error) || "Failed to remove capability" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 