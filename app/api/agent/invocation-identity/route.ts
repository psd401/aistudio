/**
 * Root-relay-only owner resolution for direct AWS skill operations.
 *
 * The AgentCore execution role intentionally cannot read the invocation signing
 * secret, so the root relay asks this trusted web boundary to verify the
 * installed context before it injects an owner into a downstream AWS request.
 * The model-facing skill cannot select or override the returned identity.
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { createLogger, generateRequestId } from "@/lib/logger"

const log = createLogger({ module: "agent-invocation-identity" })

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const invocation = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "consultation", "scheduled", "email-task"],
  })
  if (!invocation) {
    log.warn("Invocation identity verification failed", { requestId })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  return NextResponse.json({ ownerEmail: invocation.ownerEmail })
}
