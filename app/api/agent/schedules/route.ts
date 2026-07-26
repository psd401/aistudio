/**
 * Owner-bound schedule broker.
 *
 * The model-facing AgentCore runtime has no DynamoDB schedule writes,
 * EventBridge Scheduler permissions, or iam:PassRole. It can submit only a
 * schedule specification to this endpoint. The owner comes exclusively from
 * the router-signed invocation context; destination identity comes exclusively
 * from the trusted agent users table.
 */

import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  AgentScheduleConflictError,
  AgentScheduleNotConfiguredError,
  AgentScheduleNotFoundError,
  AgentScheduleQuotaError,
  AgentScheduleSyncError,
  AgentScheduleUserNotReadyError,
  createAgentScheduleService,
} from "@/lib/agent-schedules/service"
import { AgentScheduleInputError } from "@/lib/agent-schedules/validation"

const log = createLogger({ module: "agent-schedule-broker" })
const AUTHORITY_FIELDS = [
  "ownerEmail",
  "userEmail",
  "userId",
  "googleIdentity",
  "dmSpaceName",
  "workspacePrefix",
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasAuthoritySelector(body: Record<string, unknown>): boolean {
  return AUTHORITY_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(body, field)
  )
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const invocation = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner"],
  })
  if (!invocation) {
    log.warn("Schedule broker request has no owner-mode context", { requestId })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!isObject(rawBody)) {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 }
    )
  }
  if (hasAuthoritySelector(rawBody)) {
    log.warn(
      "Rejected model-supplied schedule authority selector",
      sanitizeForLogging({
        actorEmail: invocation.actorEmail,
        ownerEmail: invocation.ownerEmail,
        requestId,
      })
    )
    return NextResponse.json(
      { error: "Identity and destination fields are not accepted" },
      { status: 400 }
    )
  }

  try {
    const service = createAgentScheduleService()
    switch (rawBody.operation) {
      case "list":
        return NextResponse.json({
          schedules: await service.list(invocation.ownerEmail),
        })
      case "create":
        return NextResponse.json(
          {
            created: await service.create(invocation.ownerEmail, {
              name: rawBody.name,
              prompt: rawBody.prompt,
              cron: rawBody.cron,
              timezone: rawBody.timezone,
              disabled: rawBody.disabled,
            }),
          },
          { status: 201 }
        )
      case "update":
        return NextResponse.json({
          updated: await service.update(invocation.ownerEmail, {
            scheduleId: rawBody.scheduleId,
            name: rawBody.name,
            prompt: rawBody.prompt,
            cron: rawBody.cron,
            timezone: rawBody.timezone,
            enabled: rawBody.enabled,
          }),
        })
      case "delete":
        return NextResponse.json({
          deleted: await service.delete(
            invocation.ownerEmail,
            rawBody.scheduleId
          ),
        })
      default:
        return NextResponse.json(
          { error: "operation must be create, list, update, or delete" },
          { status: 400 }
        )
    }
  } catch (error) {
    if (error instanceof AgentScheduleInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof AgentScheduleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof AgentScheduleConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof AgentScheduleQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 429 })
    }
    if (
      error instanceof AgentScheduleUserNotReadyError ||
      error instanceof AgentScheduleNotConfiguredError
    ) {
      return NextResponse.json({ error: error.message }, { status: 503 })
    }
    if (error instanceof AgentScheduleSyncError) {
      log.error("Schedule broker synchronization failure", {
        requestId,
        error: error.message,
      })
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    log.error("Schedule broker failure", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: "Schedule operation failed" },
      { status: 502 }
    )
  }
}
