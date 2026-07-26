/**
 * Retired raw Workspace-token endpoint.
 *
 * The model-facing runtime must never receive a reusable Google access token.
 * All Google operations now run through /api/agent/workspace-execute, where the
 * trusted web tier derives the owner, validates an operation allowlist, injects
 * the token only into the child process, and returns bounded command output.
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { createLogger, generateRequestId } from "@/lib/logger"

const log = createLogger({ module: "agent-workspace-token-retired" })

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const invocation = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!invocation) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  log.warn("Rejected request to retired raw token endpoint", {
    requestId,
    mode: invocation.mode,
  })
  return NextResponse.json(
    {
      error:
        "Raw Workspace tokens are not available. Use the Workspace operation broker.",
    },
    { status: 410 },
  )
}
