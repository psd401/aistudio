import { NextRequest, NextResponse } from "next/server"
import { createRole, getRoles } from "@/lib/db/drizzle"
import { requireAdmin } from "@/lib/auth/admin-check"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.list");
  const log = createLogger({ requestId, route: "api.admin.roles" });
  
  log.info("GET /api/admin/roles - Fetching all roles");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get all roles
    const result = await getRoles()

    const roles = result.map((record) => ({
      id: String(record.id),
      name: String(record.name),
    }))

    log.info("Roles retrieved successfully", { count: roles.length });
    timer({ status: "success", count: roles.length });
    
    return NextResponse.json(
      {
        isSuccess: true,
        data: roles
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching roles", error);
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to fetch roles"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.roles.create");
  const log = createLogger({ requestId, route: "api.admin.roles" });
  
  log.info("POST /api/admin/roles - Creating new role");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const body = await request.json()
    
    log.debug("Creating role", { roleName: body.name });
    
    const role = await createRole(body)
    
    log.info("Role created successfully", { roleId: role.id });
    timer({ status: "success" });
    
    return NextResponse.json(
      { role },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error creating role:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create role" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 