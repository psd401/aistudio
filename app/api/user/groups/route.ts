import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserRolesByCognitoSub } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.user.groups.list");
  const log = createLogger({ requestId, route: "api.user.groups" });
  
  log.info("GET /api/user/groups - Fetching user groups");
  
  try {
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized - No session");
      timer({ status: "error", reason: "unauthorized" });
      return NextResponse.json(
        { isSuccess: false, message: "Unauthorized" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }

    // Get user roles
    const groups = await getUserRolesByCognitoSub(session.sub)

    log.info("User groups fetched successfully", { count: groups.length });
    timer({ status: "success", count: groups.length });
    
    return NextResponse.json({ isSuccess: true, groups }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching user groups", error)
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to fetch user groups"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 