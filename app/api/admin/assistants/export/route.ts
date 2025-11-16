import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { getAssistantDataForExport, createExportFile } from "@/lib/assistant-export-import"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.export");
  const log = createLogger({ requestId, route: "api.admin.assistants.export" });
  
  log.info("POST /api/admin/assistants/export - Exporting assistants");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get assistant IDs from request body
    const body = await request.json()
    const { assistantIds } = body

    if (!Array.isArray(assistantIds) || assistantIds.length === 0) {
      log.warn("No assistants selected for export");
      timer({ status: "error", reason: "no_assistants" });
      return NextResponse.json(
        { isSuccess: false, message: "No assistants selected for export" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    // Validate IDs are numbers
    const invalidIds = assistantIds.filter(id => !Number.isInteger(id) || id <= 0)
    if (invalidIds.length > 0) {
      log.warn("Invalid assistant IDs", { invalidIds });
      timer({ status: "error", reason: "invalid_ids" });
      return NextResponse.json(
        { isSuccess: false, message: `Invalid assistant IDs: ${invalidIds.join(', ')}` },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    log.debug("Exporting assistants", { count: assistantIds.length })

    // Fetch assistant data
    const assistants = await getAssistantDataForExport(assistantIds)

    if (assistants.length === 0) {
      log.warn("No assistants found with provided IDs");
      timer({ status: "error", reason: "not_found" });
      return NextResponse.json(
        { isSuccess: false, message: "No assistants found with the provided IDs" },
        { status: 404, headers: { "X-Request-Id": requestId } }
      )
    }

    // Create export file
    const exportData = createExportFile(assistants)

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-').slice(0, -5)
    const filename = `assistants-export-${timestamp}.json`

    // Return JSON file as download
    log.info("Export successful", { assistantCount: assistants.length, filename });
    timer({ status: "success", count: assistants.length });
    
    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache',
        'X-Request-Id': requestId
      }
    })

  } catch (error) {
    timer({ status: "error" });
    log.error('Error exporting assistants', error)
    return NextResponse.json(
      { isSuccess: false, message: 'Failed to export assistants' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}