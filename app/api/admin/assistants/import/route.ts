import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-check";
import { getServerSession } from "@/lib/auth/server-session";
import { resolveUserId } from "@/lib/auth/resolve-user";
import type { ExportFormat } from "@/lib/assistant-export-import";
import {
  AssistantImportServiceError,
  createAssistantsFromImport,
  IMPORTED_ASSISTANT_STATUS,
} from "@/lib/assistant-architect/import-service";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

interface AssistantImportResult {
  name: string;
  id?: number;
  status: "success" | "error";
  error?: string;
}

function isSupportedImportFile(file: File): boolean {
  return (
    !file.type || file.type === "application/json" || file.type === "text/json"
  );
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.import");
  const log = createLogger({ requestId, route: "api.admin.assistants.import" });

  log.info("POST /api/admin/assistants/import - Importing assistants");

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
      return NextResponse.json(
        { isSuccess: false, message: "Session error" },
        { status: 500 },
      );
    }

    // Parse form data to get the file
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { isSuccess: false, message: "No file provided" },
        { status: 400 },
      );
    }

    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { isSuccess: false, message: "File too large. Maximum size is 10MB" },
        { status: 400 },
      );
    }

    // Verify MIME type — only accept JSON files
    if (!isSupportedImportFile(file)) {
      return NextResponse.json(
        {
          isSuccess: false,
          message: "Invalid file type. Only JSON files are accepted",
        },
        { status: 400 },
      );
    }

    // Read and parse file
    const fileContent = await file.text();
    let importData: ExportFormat;

    try {
      importData = JSON.parse(fileContent);
    } catch {
      return NextResponse.json(
        { isSuccess: false, message: "Invalid JSON file" },
        { status: 400 },
      );
    }

    log.info("Starting import", {
      assistantCount: importData.assistants.length,
    });

    // Get user ID (provisions if missing)
    const userId = await resolveUserId(session, requestId);

    const serviceResult = await createAssistantsFromImport(importData, userId);
    const importResults: AssistantImportResult[] = serviceResult.results.map(
      (result) =>
        result.status === IMPORTED_ASSISTANT_STATUS
          ? { name: result.name, id: result.id, status: "success" }
          : result,
    );
    const successCount = serviceResult.successful;

    if (successCount === 0) {
      return NextResponse.json(
        {
          isSuccess: false,
          message: "Failed to import any assistants",
          details: importResults,
        },
        { status: 500 },
      );
    }

    log.info(
      `Successfully imported ${successCount} out of ${importData.assistants.length} assistants`,
    );
    timer({
      status: "success",
      successCount,
      totalCount: importData.assistants.length,
    });

    return NextResponse.json({
      isSuccess: true,
      message: `Successfully imported ${successCount} assistant(s)`,
      data: {
        total: importData.assistants.length,
        successful: successCount,
        failed: importData.assistants.length - successCount,
        results: importResults,
        modelMappings: serviceResult.modelMappings,
      },
    });
  } catch (error) {
    timer({ status: "error" });
    if (
      error instanceof AssistantImportServiceError &&
      error.code === "VALIDATION_ERROR"
    ) {
      log.warn("Assistant import validation failed", {
        error: error.message,
      });
      return NextResponse.json(
        { isSuccess: false, message: error.message },
        { status: 400 },
      );
    }
    log.error("Error importing assistants:", error);

    return NextResponse.json(
      { isSuccess: false, message: "Failed to import assistants" },
      { status: 500 },
    );
  }
}
