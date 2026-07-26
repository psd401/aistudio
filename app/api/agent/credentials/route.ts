import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId } from "@/lib/logger"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  AgentCredentialBroker,
  AgentCredentialInputError,
  AgentCredentialNotConfiguredError,
} from "@/lib/agent-credentials/broker"

const log = createLogger({ module: "agent-credential-broker" })
const AUTHORITY_FIELDS = [
  "ownerEmail",
  "userEmail",
  "userId",
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const invocation = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!invocation) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!isObject(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (
    AUTHORITY_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(body, field)
    )
  ) {
    return NextResponse.json(
      { error: "Owner selectors are not accepted" },
      { status: 400 }
    )
  }

  try {
    const broker = new AgentCredentialBroker()
    switch (body.operation) {
      case "get": {
        const credential = await broker.get(
          invocation.ownerEmail,
          body.name,
          {
            sharedOnly: body.sharedOnly === true,
            sessionId: invocation.sessionId,
          }
        )
        return credential
          ? NextResponse.json({ credential })
          : NextResponse.json({ error: "not_found" }, { status: 404 })
      }
      case "list": {
        const credentials = await broker.list(invocation.ownerEmail)
        return NextResponse.json({
          credentials,
          count: credentials.length,
        })
      }
      case "put": {
        if (invocation.mode !== "owner") {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }
        return NextResponse.json({
          credential: await broker.put(
            invocation.ownerEmail,
            body.name,
            body.value
          ),
        })
      }
      case "request": {
        if (invocation.mode !== "owner") {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }
        return NextResponse.json({
          requestId: await broker.request(
            invocation.ownerEmail,
            body.name,
            body.reason,
            body.skillContext
          ),
        })
      }
      case "check-skill-access":
        return NextResponse.json({
          granted: await broker.canAccessSkill(
            invocation.ownerEmail,
            body.capability,
            body.skillId
          ),
        })
      default:
        return NextResponse.json(
          { error: "Unsupported operation" },
          { status: 400 }
        )
    }
  } catch (error) {
    if (error instanceof AgentCredentialInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof AgentCredentialNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 })
    }
    log.error("Agent credential broker failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: "Credential operation failed" },
      { status: 502 }
    )
  }
}
