import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { mintAgentWorkspaceTokenViaBoundary } from "@/lib/agent-workspace/mint-client"
import {
  AccountNotProvisionedError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"
import { getFreshAccessTokenForUser } from "@/lib/agent/workspace-token"
import {
  executeWorkspaceCommand,
  type WorkspaceCommand,
} from "@/lib/agent-workspace/command-executor"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-workspace-execute" })

function isCommand(value: unknown): value is WorkspaceCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<WorkspaceCommand> & Record<string, unknown>
  const allowed = new Set(["scope", "argv"])
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return false
  return (
    (candidate.scope === "agent" || candidate.scope === "user") &&
    Array.isArray(candidate.argv) &&
    candidate.argv.every((item) => typeof item === "string")
  )
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!isCommand(body)) {
    return NextResponse.json({ error: "Invalid Workspace command" }, { status: 400 })
  }

  try {
    let accessToken: string
    if (body.scope === "agent") {
      accessToken = (
        await mintAgentWorkspaceTokenViaBoundary(context.ownerEmail)
      ).accessToken
    } else {
      const token = await getFreshAccessTokenForUser(
        context.ownerEmail,
        process.env.ENVIRONMENT || "dev",
        "user_account",
        process.env.AWS_REGION || "us-east-1"
      )
      if (!token) {
        return NextResponse.json(
          { status: "needs-auth", error: "Workspace authorization is required" },
          { status: 409 }
        )
      }
      accessToken = token.access_token
    }

    const result = await executeWorkspaceCommand(body, accessToken)
    log.info(
      "Workspace command completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        scope: body.scope,
        operation: body.argv.slice(0, 4),
      })
    )
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof AccountNotProvisionedError) {
      return NextResponse.json(
        { status: "account-not-provisioned", error: "Agent account is being provisioned" },
        { status: 409 }
      )
    }
    if (error instanceof InvalidOwnerError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    const message = error instanceof Error ? error.message : String(error)
    const isPolicyError =
      message.startsWith("Workspace ") ||
      message.startsWith("Gmail ") ||
      message.startsWith("Drive ") ||
      message.startsWith("Permission ") ||
      message.startsWith("This operation")
    log.warn(
      "Workspace command rejected",
      sanitizeForLogging({ requestId, ownerEmail: context.ownerEmail, error: message })
    )
    return NextResponse.json(
      { error: isPolicyError ? message : "Workspace operation failed" },
      { status: isPolicyError ? 400 : 502 }
    )
  }
}
