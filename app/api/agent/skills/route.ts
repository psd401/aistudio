import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId } from "@/lib/logger"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  AgentSkillInputError,
  AgentSkillOwnerNotFoundError,
  AgentSkillsService,
} from "@/lib/agent-skills/service"

const log = createLogger({ module: "agent-skills-broker" })
const AUTHORITY_FIELDS = ["ownerEmail", "userEmail", "userId"] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const invocation = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner"],
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
    const service = new AgentSkillsService()
    switch (body.operation) {
      case "search": {
        const skills = await service.search(
          invocation.ownerEmail,
          body.query
        )
        return NextResponse.json({ skills, count: skills.length })
      }
      case "load": {
        const skill = await service.load(invocation.ownerEmail, body.name)
        return skill
          ? NextResponse.json(skill)
          : NextResponse.json({ error: "not_found" }, { status: 404 })
      }
      case "author":
        return NextResponse.json(
          await service.author(invocation.ownerEmail, {
            name: body.name,
            summary: body.summary,
            skillMdBase64: body.skillMdBase64,
            files: body.files,
          }),
          { status: 201 }
        )
      default:
        return NextResponse.json(
          { error: "Unsupported operation" },
          { status: 400 }
        )
    }
  } catch (error) {
    if (error instanceof AgentSkillInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof AgentSkillOwnerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    log.error("Agent skill broker failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: "Skill operation failed" },
      { status: 502 }
    )
  }
}
