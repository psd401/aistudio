import { NextRequest, NextResponse } from "next/server"
import {
  DeleteCommand,
  type DeleteCommandOutput,
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandOutput,
  UpdateCommand,
  type UpdateCommandOutput,
} from "@aws-sdk/lib-dynamodb"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getFreshAccessTokenForUser } from "@/lib/agent/workspace-token"
import {
  createTrustedEmailTriageLabelMapping,
  EMAIL_TRIAGE_LABELS,
  type EmailTriageLabelKey,
  type GmailLabelDescriptor,
} from "@/lib/agent/email-triage-label-map"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { ErrorFactories } from "@/lib/error-utils"

const log = createLogger({ module: "agent-email-triage" })
interface EmailTriageDynamoClient {
  send(command: GetCommand): Promise<GetCommandOutput>
  send(command: UpdateCommand): Promise<UpdateCommandOutput>
  send(command: DeleteCommand): Promise<DeleteCommandOutput>
}

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } }
) as unknown as EmailTriageDynamoClient
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/
const SAFE_STATE_FIELDS = new Set([
  "classifierStartHistoryId",
  "digestEnabled",
  "digestScheduleArn",
  "digestTime",
  "digestTz",
  "disabledAt",
  "enabled",
  "enabledAt",
  "escalation",
  "escalationConfidenceThreshold",
  "escalationMode",
  "internalDomain",
  "lastHistoryId",
  "lastPollAt",
  "learnedPatterns",
  "recentCorrections",
  "recentDecisions",
  "rules",
  "sweep",
])

function tableName(): string {
  return (
    process.env.AGENT_TRIAGE_TABLE ||
    `psd-agent-triage-${process.env.ENVIRONMENT || "dev"}`
  )
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function accessToken(ownerEmail: string): Promise<string | null> {
  const token = await getFreshAccessTokenForUser(
    ownerEmail,
    process.env.ENVIRONMENT || "dev",
    "user_account",
    process.env.AWS_REGION || "us-east-1"
  )
  return token?.access_token ?? null
}

async function gmail(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  })
}

async function gmailJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text()
    throw ErrorFactories.externalServiceError(
      "Gmail",
      new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`)
    )
  }
  if (response.status === 204) return {}
  return response.json()
}

async function ensureTrustedLabels(
  token: string,
  ownerEmail: string
): Promise<ReturnType<typeof createTrustedEmailTriageLabelMapping>> {
  const listed = objectBody(await gmailJson(await gmail(token, "/labels")))
  const liveLabels = Array.isArray(listed?.labels)
    ? (listed.labels as GmailLabelDescriptor[])
    : []
  const labelIdsByKey = Object.create(null) as Record<
    EmailTriageLabelKey,
    string
  >

  for (const key of Object.keys(EMAIL_TRIAGE_LABELS) as EmailTriageLabelKey[]) {
    const expectedName = EMAIL_TRIAGE_LABELS[key]
    const matches = liveLabels.filter(
      (label) => label.name === expectedName && label.type === "user"
    )
    if (matches.length > 1) {
      throw ErrorFactories.bizInvalidState(
        `resolve Gmail label ${key}`,
        "duplicate",
        "unique"
      )
    }
    let id = matches[0]?.id
    if (id === undefined) {
      const created = objectBody(
        await gmailJson(
          await gmail(token, "/labels", {
            method: "POST",
            body: JSON.stringify({
              name: expectedName,
              labelListVisibility: "labelShow",
              messageListVisibility: "show",
            }),
          })
        )
      )
      id = created?.id
    }
    if (typeof id !== "string") {
      throw new TypeError(`Gmail did not return a label id for ${key}`)
    }
    labelIdsByKey[key] = id
  }

  const mapping = createTrustedEmailTriageLabelMapping({
    ownerEmail,
    labelIdsByKey,
  })
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { userEmail: ownerEmail },
      UpdateExpression:
        "SET #labels = :labels, #ids = :ids, #version = :version, " +
        "#provenance = :provenance, #owner = :owner, #resolved = :resolved",
      ExpressionAttributeNames: {
        "#labels": "labels",
        "#ids": "labelIdsByKey",
        "#version": "labelMappingVersion",
        "#provenance": "labelMappingProvenance",
        "#owner": "labelMappingOwnerEmail",
        "#resolved": "labelMappingResolvedAt",
      },
      ExpressionAttributeValues: {
        ":labels": mapping.labels,
        ":ids": mapping.labelIdsByKey,
        ":version": mapping.labelMappingVersion,
        ":provenance": mapping.labelMappingProvenance,
        ":owner": mapping.labelMappingOwnerEmail,
        ":resolved": mapping.labelMappingResolvedAt,
      },
    })
  )
  return mapping
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const body = objectBody(raw)
  if (!body || typeof body.operation !== "string") {
    return NextResponse.json({ error: "Invalid triage request" }, { status: 400 })
  }
  if (["ownerEmail", "userEmail", "userId"].some((key) => key in body)) {
    return NextResponse.json({ error: "Owner selectors are not accepted" }, { status: 400 })
  }

  try {
    if (body.operation === "get-state") {
      const result = await ddb.send(
        new GetCommand({
          TableName: tableName(),
          Key: { userEmail: context.ownerEmail },
        })
      )
      return NextResponse.json({ state: result.Item ?? null })
    }
    if (body.operation === "update-state") {
      if (context.mode !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const attrs = objectBody(body.attrs)
      if (
        !attrs ||
        Object.keys(attrs).length === 0 ||
        Object.keys(attrs).some((field) => !SAFE_STATE_FIELDS.has(field))
      ) {
        return NextResponse.json({ error: "Invalid triage state update" }, { status: 400 })
      }
      const names: Record<string, string> = {}
      const values: Record<string, unknown> = {}
      const sets: string[] = []
      for (const [index, [field, value]] of Object.entries(attrs).entries()) {
        names[`#field${index}`] = field
        values[`:value${index}`] = value
        sets.push(`#field${index} = :value${index}`)
      }
      await ddb.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { userEmail: context.ownerEmail },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        })
      )
      return NextResponse.json({ ok: true })
    }
    if (body.operation === "delete-state") {
      if (context.mode !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      await ddb.send(
        new DeleteCommand({
          TableName: tableName(),
          Key: { userEmail: context.ownerEmail },
        })
      )
      return NextResponse.json({ ok: true })
    }

    const token = await accessToken(context.ownerEmail)
    if (!token) {
      return NextResponse.json(
        { status: "needs-auth", error: "Workspace authorization is required" },
        { status: 409 }
      )
    }
    let result: unknown
    if (body.operation === "gmail-profile") {
      result = await gmailJson(await gmail(token, "/profile"))
    } else if (body.operation === "ensure-labels") {
      if (context.mode !== "owner" || Object.keys(body).length !== 1) {
        return NextResponse.json({ error: "Invalid label resolution request" }, { status: 400 })
      }
      const mapping = await ensureTrustedLabels(token, context.ownerEmail)
      result = {
        labels: mapping.labels,
        labelIdsByKey: mapping.labelIdsByKey,
      }
    } else if (body.operation === "list-labels") {
      result = await gmailJson(await gmail(token, "/labels"))
    } else if (body.operation === "create-label" && typeof body.name === "string") {
      if (body.name.length === 0 || body.name.length > 225) {
        return NextResponse.json({ error: "Invalid label name" }, { status: 400 })
      }
      result = await gmailJson(
        await gmail(token, "/labels", {
          method: "POST",
          body: JSON.stringify({
            name: body.name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          }),
        })
      )
    } else if (
      body.operation === "rename-label" &&
      typeof body.labelId === "string" &&
      SAFE_ID.test(body.labelId) &&
      typeof body.name === "string" &&
      body.name.length <= 225
    ) {
      result = await gmailJson(
        await gmail(token, `/labels/${body.labelId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: body.name }),
        })
      )
    } else if (
      body.operation === "delete-label" &&
      typeof body.labelId === "string" &&
      SAFE_ID.test(body.labelId)
    ) {
      result = await gmailJson(
        await gmail(token, `/labels/${body.labelId}`, { method: "DELETE" })
      )
    } else if (
      body.operation === "modify-message" &&
      typeof body.messageId === "string" &&
      SAFE_ID.test(body.messageId) &&
      Array.isArray(body.addLabelIds) &&
      Array.isArray(body.removeLabelIds)
    ) {
      const labels = [...body.addLabelIds, ...body.removeLabelIds]
      if (
        labels.some((label) => typeof label !== "string" || !SAFE_ID.test(label)) ||
        body.addLabelIds.some(
          (label) => label === "TRASH" || label === "SPAM"
        )
      ) {
        return NextResponse.json({ error: "Invalid message labels" }, { status: 400 })
      }
      result = await gmailJson(
        await gmail(token, `/messages/${body.messageId}/modify`, {
          method: "POST",
          body: JSON.stringify({
            addLabelIds: body.addLabelIds,
            removeLabelIds: body.removeLabelIds,
          }),
        })
      )
    } else {
      return NextResponse.json({ error: "Unsupported triage operation" }, { status: 400 })
    }
    log.info(
      "Owner-bound triage operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        operation: body.operation,
      })
    )
    return NextResponse.json({ result })
  } catch (error) {
    log.error(
      "Owner-bound triage broker failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        operation: body.operation,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "Triage operation failed" }, { status: 502 })
  }
}
