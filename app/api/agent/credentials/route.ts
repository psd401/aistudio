import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId } from "@/lib/logger"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  AgentCredentialBroker,
  AgentCredentialInputError,
  AgentCredentialNotConfiguredError,
} from "@/lib/agent-credentials/broker"
import {
  DeepResearchOperationError,
  executeDeepResearchStartOperation,
  executeDeepResearchStatusOperation,
  executeOpenAiImageOperation,
  executePlaudOperation,
  executePsdDataOperation,
  executeFreshserviceOperation,
} from "@/lib/agent-credentials/owner-operation-broker"

const log = createLogger({ module: "agent-credential-broker" })
const AUTHORITY_FIELDS = [
  "ownerEmail",
  "userEmail",
  "userId",
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

type AgentInvocation = NonNullable<
  Awaited<ReturnType<typeof verifyAgentInvocationContext>>
>

async function executeCredentialOperation(
  body: Record<string, unknown>,
  invocation: AgentInvocation
): Promise<NextResponse> {
  const broker = new AgentCredentialBroker()
  switch (body.operation) {
    case "get":
    case "list":
      return NextResponse.json(
        { error: "Plaintext credential access is not supported" },
        { status: 403 }
      )
    case "psd-data-mcp":
      return NextResponse.json(
        await executePsdDataOperation({
          ownerEmail: invocation.ownerEmail,
          sessionId: invocation.sessionId,
          method: body.method,
          params: body.params,
        })
      )
    case "plaud-mcp":
      return NextResponse.json(
        await executePlaudOperation({
          ownerEmail: invocation.ownerEmail,
          sessionId: invocation.sessionId,
          method: body.method,
          toolName: body.toolName,
          toolArgs: body.toolArgs,
        })
      )
    case "openai-image": {
      const granted = await broker.canAccessSkill(
        invocation.ownerEmail,
        "skill.image-gen",
        undefined
      )
      if (!granted) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      return NextResponse.json(
        await executeOpenAiImageOperation({
          ownerEmail: invocation.ownerEmail,
          sessionId: invocation.sessionId,
          prompt: body.prompt,
          size: body.size,
          quality: body.quality,
          background: body.background,
          referenceDataUrl: body.referenceDataUrl,
        })
      )
    }
    case "deep-research-start":
      // Agent access is deliberately the authorization gate for Deep
      // Research. The shared district credential is protected by the signed
      // owner context and existing reservation ceilings, not canAccessSkill.
      return NextResponse.json(
        await executeDeepResearchStartOperation({
          ownerEmail: invocation.ownerEmail,
          prompt: body.prompt,
        })
      )
    case "deep-research-status":
      // Keep status checks on the same owner-context-only boundary as starts;
      // the operation itself masks missing and foreign interaction ids.
      return NextResponse.json(
        await executeDeepResearchStatusOperation({
          ownerEmail: invocation.ownerEmail,
          interactionId: body.interactionId,
        })
      )
    case "freshservice": {
      // Freshservice uses the caller's own owner-scoped key, so that
      // credential is the authorization. Unlike operations backed by a shared
      // district credential, this operation must not gain an ungrantable
      // capability gate between the signed owner context and the broker.
      return NextResponse.json(
        await executeFreshserviceOperation({
          ownerEmail: invocation.ownerEmail,
          sessionId: invocation.sessionId,
          path: body.path,
          method: body.method,
          body: body.body,
        })
      )
    }
    case "put":
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
    case "request":
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
    return await executeCredentialOperation(body, invocation)
  } catch (error) {
    if (error instanceof AgentCredentialInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof AgentCredentialNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 })
    }
    if (error instanceof DeepResearchOperationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      )
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
