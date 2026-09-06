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
  // `workspacePrefix` is returned alongside the owner because agent-media
  // (#1738) reads and writes objects inside the caller's own private workspace
  // prefix, and that prefix must come from the SIGNED context rather than from
  // the model. Both fields are verified claims from the same token; neither is
  // selectable by the skill that triggered the call. Additive — the existing
  // relay consumer reads only `ownerEmail`, so a rolling deploy is safe in
  // either order.
  return NextResponse.json({
    ownerEmail: invocation.ownerEmail,
    workspacePrefix: invocation.workspacePrefix,
  })
}
