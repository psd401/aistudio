import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import {
  getAssistantArchitects,
  createAssistantArchitectByCognitoSub,
  updateAssistantArchitect,
  deleteAssistantArchitect,
  approveAssistantArchitect,
  rejectAssistantArchitect
} from "@/lib/db/drizzle"

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.list");
  const log = createLogger({ requestId, route: "api.admin.assistants" });
  
  log.info("GET /api/admin/assistants - Fetching all assistants");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get session for user ID
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.error("Session error - no session or sub");
      timer({ status: "error", reason: "session_error" });
      return NextResponse.json(
        { isSuccess: false, message: "Session error" },
        { status: 500 }
      )
    }
    
    log.debug("Admin authenticated", { userId: session.sub });

    // Get all assistant architects
    const assistants = await getAssistantArchitects()

    log.info("Assistants retrieved successfully", { count: assistants.length });
    timer({ status: "success", count: assistants.length });

    return NextResponse.json(
      {
        isSuccess: true,
        message: "Assistants retrieved successfully",
        data: assistants
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching assistants:", error)
    return NextResponse.json(
      { isSuccess: false, message: "Failed to fetch assistants" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.create");
  const log = createLogger({ requestId, route: "api.admin.assistants" });
  
  log.info("POST /api/admin/assistants - Creating or managing assistant");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get session for user ID
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.error("Session error - no session or sub");
      timer({ status: "error", reason: "session_error" });
      return NextResponse.json(
        { isSuccess: false, message: "Session error" },
        { status: 500 }
      )
    }
    
    log.debug("Admin authenticated", { userId: session.sub });

    const body = await request.json()
    
    log.debug("Assistant operation", { 
      action: body.action, 
      id: body.id,
      name: body.name 
    });
    
    // Handle approve/reject actions
    if (body.action === 'approve') {
      const result = await approveAssistantArchitect(body.id)
      log.info("Assistant approved", { assistantId: body.id });
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
      await rejectAssistantArchitect(body.id)
      log.info("Assistant rejected", { assistantId: body.id });
      timer({ status: "success", action: "reject" });
      return NextResponse.json(
        {
          isSuccess: true,
          message: 'Assistant rejected successfully'
        },
        { headers: { "X-Request-Id": requestId } }
      )
    }

    // Otherwise, create new assistant
    const assistant = await createAssistantArchitectByCognitoSub({
      name: body.name,
      description: body.description,
      cognitoSub: session.sub,
      status: body.status || 'draft'
    })

    log.info("Assistant created successfully", { assistantId: assistant.id });
    timer({ status: "success", action: "create" });

    return NextResponse.json(
      {
        isSuccess: true,
        message: 'Assistant created successfully',
        data: assistant
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error('Error creating assistant:', error)
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to create assistant' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function PUT(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.update");
  const log = createLogger({ requestId, route: "api.admin.assistants" });
  
  log.info("PUT /api/admin/assistants - Updating assistant");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get session for user ID
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.error("Session error - no session or sub");
      timer({ status: "error", reason: "session_error" });
      return NextResponse.json(
        { isSuccess: false, message: "Session error" },
        { status: 500 }
      )
    }
    
    log.debug("Admin authenticated", { userId: session.sub });

    const body = await request.json()
    const { id, ...updates } = body
    
    log.debug("Updating assistant", { assistantId: id, updates });

    const assistant = await updateAssistantArchitect(id, updates)

    log.info("Assistant updated successfully", { assistantId: id });
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

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.delete");
  const log = createLogger({ requestId, route: "api.admin.assistants" });
  
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  
  log.info("DELETE /api/admin/assistants - Deleting assistant", { assistantId: id });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get session for user ID
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.error("Session error - no session or sub");
      timer({ status: "error", reason: "session_error" });
      return NextResponse.json(
        { isSuccess: false, message: "Session error" },
        { status: 500 }
      )
    }
    
    log.debug("Admin authenticated", { userId: session.sub });

    if (!id) {
      log.warn("Missing assistant ID in delete request");
      timer({ status: "error", reason: "missing_id" });
      return NextResponse.json(
        { isSuccess: false, message: 'Missing assistant ID' },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const assistantId = Number.parseInt(id, 10)
    if (Number.isNaN(assistantId)) {
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