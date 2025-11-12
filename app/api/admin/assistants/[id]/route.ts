import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { 
  updateAssistantArchitect, 
  deleteAssistantArchitect,
  approveAssistantArchitect,
  rejectAssistantArchitect
} from "@/lib/db/data-api-adapter"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.id.update");
  const log = createLogger({ requestId, route: "api.admin.assistants.[id]" });
  
  const resolvedParams = await params
  const { id } = resolvedParams
  
  log.info("PUT /api/admin/assistants/[id] - Updating assistant", { assistantId: id });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = await request.json()
    
    log.debug("Updating assistant details", { assistantId: id, updates: body });
    
    const assistantId = Number.parseInt(id, 10)
    if (isNaN(assistantId)) {
      log.warn("Invalid assistant ID format", { id });
      timer({ status: "error", reason: "invalid_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid assistant ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const assistant = await updateAssistantArchitect(assistantId, body)

    log.info("Assistant updated successfully", { assistantId });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: 'Assistant updated successfully',
        data: assistant
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error('Error updating assistant:', error)
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to update assistant' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.id.delete");
  const log = createLogger({ requestId, route: "api.admin.assistants.[id]" });
  
  const resolvedParams = await params
  const { id } = resolvedParams
  
  log.info("DELETE /api/admin/assistants/[id] - Deleting assistant", { assistantId: id });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const assistantId = Number.parseInt(id, 10)
    if (isNaN(assistantId)) {
      log.warn("Invalid assistant ID format", { id });
      timer({ status: "error", reason: "invalid_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid assistant ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    await deleteAssistantArchitect(assistantId)

    log.info("Assistant deleted successfully", { assistantId });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: 'Assistant deleted successfully'
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error('Error deleting assistant:', error)
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to delete assistant' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.id.action");
  const log = createLogger({ requestId, route: "api.admin.assistants.[id]" });
  
  const resolvedParams = await params
  const { id } = resolvedParams
  
  log.info("POST /api/admin/assistants/[id] - Processing assistant action", { assistantId: id });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = await request.json()
    
    log.debug("Assistant action", { assistantId: id, action: body.action });
    
    const assistantId = Number.parseInt(id, 10)
    if (isNaN(assistantId)) {
      log.warn("Invalid assistant ID format", { id });
      timer({ status: "error", reason: "invalid_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Invalid assistant ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    if (body.action === 'approve') {
      const result = await approveAssistantArchitect(assistantId)
      log.info("Assistant approved", { assistantId });
      timer({ status: "success", action: "approve" });
      return NextResponse.json(
        {
          isSuccess: true,
          message: 'Assistant approved successfully',
          data: result
        },
        { headers: { "X-Request-Id": requestId } }
      )
    }

    if (body.action === 'reject') {
      await rejectAssistantArchitect(assistantId)
      log.info("Assistant rejected", { assistantId });
      timer({ status: "success", action: "reject" });
      return NextResponse.json(
        {
          isSuccess: true,
          message: 'Assistant rejected successfully'
        },
        { headers: { "X-Request-Id": requestId } }
      )
    }

    log.warn("Invalid action provided", { action: body.action });
    timer({ status: "error", reason: "invalid_action" });
    return NextResponse.json(
      { isSuccess: false, message: 'Invalid action' },
      { status: 400, headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error('Error processing assistant action:', error)
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to process action' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}