import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { getTools } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.tools");
  const log = createLogger({ requestId, route: "api.admin.tools" });

  log.info("GET /api/admin/tools - Fetching all tools");

  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get all tools using Drizzle
    const result = await getTools()

    const tools = result.map((record) => ({
      id: String(record.id),
      name: record.name,
      identifier: record.identifier,
      description: record.description ?? null,
    }))

    log.info("Tools retrieved successfully", { count: tools.length });
    timer({ status: "success", count: tools.length });

    return NextResponse.json(
      {
        isSuccess: true,
        data: tools
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching tools", error);
    return NextResponse.json(
      {
        isSuccess: false,
        message: error instanceof Error ? error.message : "Failed to fetch tools"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}