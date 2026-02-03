import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { deleteNavigationItem } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.navigation.delete");
  const log = createLogger({ requestId, route: "api.admin.navigation.delete" });
  
  log.info("DELETE /api/admin/navigation/[id] - Deleting navigation item");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const resolvedParams = await params
    const { id } = resolvedParams

    // Delete the navigation item
    const itemId = Number.parseInt(id, 10);
    log.debug("Deleting navigation item", { itemId });
    await deleteNavigationItem(itemId)

    log.info("Navigation item deleted successfully", { itemId });
    timer({ status: "success" });
    
    return NextResponse.json({
      isSuccess: true,
      message: "Navigation item deleted successfully"
    }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error deleting navigation item", error)
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to delete navigation item"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 