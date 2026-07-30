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
  requiredWorkspaceScopeGap,
  validateEmailTaskWorkspaceCommand,
  validateScheduledWorkspaceCommand,
  validateWorkspaceCommand,
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

async function readWorkspaceCommand(
  request: NextRequest
): Promise<
  | { ok: true; command: WorkspaceCommand }
  | { ok: false; response: NextResponse }
> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      ),
    }
  }
  return isCommand(body)
    ? { ok: true, command: body }
    : {
        ok: false,
        response: NextResponse.json(
          { error: "Invalid Workspace command" },
          { status: 400 }
        ),
      }
}

function validateCommandForMode(
  command: WorkspaceCommand,
  mode: string
): NextResponse | null {
  try {
    if (mode === "email-task") {
      validateEmailTaskWorkspaceCommand(command)
    } else if (mode === "scheduled") {
      validateScheduledWorkspaceCommand(command)
    } else {
      validateWorkspaceCommand(command)
    }
    return null
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Workspace command rejected",
      },
      { status: 400 },
    )
  }
}

async function workspaceAccessToken(
  command: WorkspaceCommand,
  ownerEmail: string
): Promise<
  | { ok: true; accessToken: string }
  | { ok: false; response: NextResponse }
> {
  if (command.scope === "agent") {
    const token = await mintAgentWorkspaceTokenViaBoundary(ownerEmail)
    return { ok: true, accessToken: token.accessToken }
  }
  const token = await getFreshAccessTokenForUser(
    ownerEmail,
    process.env.ENVIRONMENT || "dev",
    "user_account",
    process.env.AWS_REGION || "us-east-1"
  )
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { status: "needs-auth", error: "Workspace authorization is required" },
        { status: 409 }
      ),
    }
  }
  const scopeGap = requiredWorkspaceScopeGap(command.argv, token.scope)
  if (scopeGap) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          status: "scope-upgrade-required",
          missingScopes: scopeGap.scopes,
          capability: scopeGap.capability,
          error: "Additional Workspace authorization is required",
        },
        { status: 409 },
      ),
    }
  }
  return { ok: true, accessToken: token.access_token }
}

function workspaceExecutionErrorResponse(
  error: unknown,
  requestId: string,
  ownerEmail: string
): NextResponse {
  const errorCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined
  if (errorCode === "invalid_grant") {
    return NextResponse.json(
      {
        status: "token-revoked",
        error: "Workspace authorization was revoked",
      },
      { status: 409 },
    )
  }
  if (error instanceof AccountNotProvisionedError) {
    return NextResponse.json(
      {
        status: "account-not-provisioned",
        error: "Agent account is being provisioned",
      },
      { status: 409 }
    )
  }
  if (error instanceof InvalidOwnerError) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  const message = error instanceof Error ? error.message : String(error)
  const policyPrefixes = [
    "Workspace ",
    "Gmail ",
    "Drive ",
    "Permission ",
    "This operation",
  ]
  const isPolicyError = policyPrefixes.some((prefix) =>
    message.startsWith(prefix)
  )
  log.warn(
    "Workspace command rejected",
    sanitizeForLogging({ requestId, ownerEmail, error: message })
  )
  return NextResponse.json(
    { error: isPolicyError ? message : "Workspace operation failed" },
    { status: isPolicyError ? 400 : 502 }
  )
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled", "email-task"],
  })
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const parsed = await readWorkspaceCommand(request)
  if (!parsed.ok) return parsed.response
  const body = parsed.command
  const validationError = validateCommandForMode(body, context.mode)
  if (validationError) return validationError

  try {
    const token = await workspaceAccessToken(body, context.ownerEmail)
    if (!token.ok) return token.response
    const result = await executeWorkspaceCommand(body, token.accessToken)
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
    return workspaceExecutionErrorResponse(
      error,
      requestId,
      context.ownerEmail
    )
  }
}
