import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserRolesByCognitoSub } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function GET() {
  const requestId = generateRequestId()
  const timer = startTimer("GET /api/user/roles")
  const log = createLogger({ requestId, route: "/api/user/roles" })
  
  try {
    log.info("Fetching user roles")
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized - no session")
      timer({ status: "unauthorized" })
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }
    
    const roles = await getUserRolesByCognitoSub(session.sub)
    
    log.info("User roles fetched successfully", { 
      cognitoSub: session.sub,
      roleCount: roles.length 
    })
    timer({ status: "success", roleCount: roles.length })
    
    return NextResponse.json({ 
      roles,
      success: true 
    })
  } catch (error) {
    log.error("Failed to fetch user roles", { 
      error: error instanceof Error ? error.message : "Unknown error" 
    })
    timer({ status: "error" })
    
    return NextResponse.json(
      { error: "Failed to fetch user roles", roles: [] },
      { status: 500 }
    )
  }
}