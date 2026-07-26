import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import {
  executeGitHubCommand,
  validateEmailTaskGitHubCommand,
  validateGitHubCommand,
} from "@/lib/agent-github/command-executor"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-github-execute" })

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "email-task"],
  })
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== "argv") ||
    !Array.isArray((raw as { argv?: unknown }).argv) ||
    !(raw as { argv: unknown[] }).argv.every((arg) => typeof arg === "string")
  ) {
    return NextResponse.json({ error: "Invalid GitHub command" }, { status: 400 })
  }
  const argv = (raw as { argv: string[] }).argv
  try {
    if (context.mode === "email-task") {
      validateEmailTaskGitHubCommand(argv)
    } else {
      validateGitHubCommand(argv)
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "GitHub command rejected" },
      { status: 400 }
    )
  }

  const secretId =
    `psd-agent-creds/${process.env.ENVIRONMENT || "dev"}/user/` +
    `${context.ownerEmail}/github_pat`
  const token = await getSecretString(secretId)
  if (!token) {
    return NextResponse.json(
      { error: "GitHub credential is not configured" },
      { status: 404 }
    )
  }
  try {
    const result = await executeGitHubCommand(argv, token)
    log.info(
      "Owner-bound GitHub command completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        command: argv.slice(0, 3),
      })
    )
    return NextResponse.json(result)
  } catch (error) {
    log.warn(
      "Owner-bound GitHub command failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "GitHub operation failed" }, { status: 502 })
  }
}
