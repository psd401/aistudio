"use server"

import { ErrorFactories, createSuccess, handleError } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger"
import { Settings } from "@/lib/settings-manager"
import type { ActionState } from "@/types"

interface FreshserviceTicketResponse {
  ticket_url: string
  ticket_id: number
}

interface FreshserviceTicketData {
  id: number | string
  display_id?: string | number
  [key: string]: unknown
}

interface FreshserviceApiResponse {
  ticket: FreshserviceTicketData
}

interface TicketInput {
  description: string
  screenshotData: string | null
  screenshotName: string | null
  screenshotType: string | null
  title: string
}

type FreshserviceSettings = Awaited<
  ReturnType<typeof Settings.getFreshservice>
>
type ConfiguredFreshserviceSettings = FreshserviceSettings & {
  apiKey: string
  departmentId: string
  domain: string
}
type AuthenticatedSession = NonNullable<
  Awaited<ReturnType<typeof getServerSession>>
>
type ActionLogger = ReturnType<typeof createLogger>

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
])
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024

function readTicketInput(formData: FormData): TicketInput {
  const input = {
    title: formData.get("title") as string,
    description: formData.get("description") as string,
    screenshotData: formData.get("screenshotData") as string | null,
    screenshotName: formData.get("screenshotName") as string | null,
    screenshotType: formData.get("screenshotType") as string | null,
  }
  const fields = []
  if (!input.title) fields.push({ field: "title", message: "Title is required" })
  if (!input.description) {
    fields.push({ field: "description", message: "Description is required" })
  }
  if (fields.length > 0) throw ErrorFactories.validationFailed(fields)
  return input
}

function validateSettings(
  settings: FreshserviceSettings,
  log: ActionLogger
): asserts settings is ConfiguredFreshserviceSettings {
  if (!settings.domain || !settings.apiKey || !settings.departmentId) {
    log.error("Freshservice not configured", {
      hasDomain: !!settings.domain,
      hasApiKey: !!settings.apiKey,
      hasDepartmentId: !!settings.departmentId,
    })
    throw ErrorFactories.sysConfigurationError(
      "Freshservice not configured. Please contact your administrator to set up FRESHSERVICE_DOMAIN, FRESHSERVICE_API_KEY, and FRESHSERVICE_DEPARTMENT_ID."
    )
  }
  const domainPattern = /^[\dA-Za-z][\dA-Za-z-]{0,61}[\dA-Za-z]$/
  if (!domainPattern.test(settings.domain)) {
    log.error("Invalid Freshservice domain format", {
      domain: sanitizeForLogging({ domain: settings.domain }),
    })
    throw ErrorFactories.validationFailed([
      { field: "domain", message: "Invalid Freshservice domain configuration" },
    ])
  }
}

function requesterName(session: AuthenticatedSession): string {
  const displayName =
    typeof session.name === "string" ? session.name.trim() : ""
  return (
    displayName ||
    [session.givenName, session.familyName].filter(Boolean).join(" ").trim()
  )
}

function decodeScreenshot(input: TicketInput, log: ActionLogger): Buffer {
  if (
    !input.screenshotType ||
    !ALLOWED_IMAGE_TYPES.has(input.screenshotType)
  ) {
    log.warn("Invalid file type", { type: input.screenshotType })
    throw ErrorFactories.validationFailed([
      {
        field: "screenshot",
        message: "Only JPEG, PNG, GIF, and WebP images are supported",
      },
    ])
  }
  const base64 = input.screenshotData?.split(",")[1]
  if (!base64) {
    throw ErrorFactories.validationFailed([
      { field: "screenshot", message: "Invalid screenshot data" },
    ])
  }
  const buffer = Buffer.from(base64, "base64")
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    log.warn("Screenshot too large", {
      size: buffer.length,
      maxSize: MAX_SCREENSHOT_BYTES,
    })
    throw ErrorFactories.validationFailed([
      { field: "screenshot", message: "Screenshot must be smaller than 10MB" },
    ])
  }
  return buffer
}

function buildMultipartBody(
  input: TicketInput,
  session: AuthenticatedSession,
  settings: ConfiguredFreshserviceSettings,
  log: ActionLogger
): { body: FormData; screenshotSize: number } {
  const buffer = decodeScreenshot(input, log)
  const body = new FormData()
  body.append("subject", input.title)
  body.append("description", input.description)
  body.append("email", session.email || "noreply@psd401.org")
  const name = requesterName(session)
  if (name) body.append("name", name)
  body.append("priority", settings.priority)
  body.append("status", settings.status)
  body.append("department_id", settings.departmentId)
  body.append("type", settings.ticketType)
  if (settings.workspaceId) body.append("workspace_id", settings.workspaceId)
  body.append(
    "attachments[]",
    new Blob([Uint8Array.from(buffer)], {
      type: input.screenshotType ?? "image/png",
    }),
    input.screenshotName || "screenshot.png"
  )
  return { body, screenshotSize: buffer.length }
}

function buildJsonBody(
  input: TicketInput,
  session: AuthenticatedSession,
  settings: ConfiguredFreshserviceSettings
): Record<string, string | number> {
  const body: Record<string, string | number> = {
    subject: input.title,
    description: input.description,
    email: session.email || "noreply@psd401.org",
    priority: Number.parseInt(settings.priority),
    status: Number.parseInt(settings.status),
    department_id: Number.parseInt(settings.departmentId),
    type: settings.ticketType,
  }
  const name = requesterName(session)
  if (name) body.name = name
  if (settings.workspaceId) {
    body.workspace_id = Number.parseInt(settings.workspaceId)
  }
  return body
}

interface FreshserviceRequestOptions {
  input: TicketInput
  log: ActionLogger
  session: AuthenticatedSession
  settings: ConfiguredFreshserviceSettings
}

async function sendFreshserviceRequest(
  options: FreshserviceRequestOptions
): Promise<Response> {
  const { input, log, session, settings } = options
  const apiUrl = `https://${settings.domain}.freshservice.com/api/v2/tickets`
  const authorization = `Basic ${Buffer.from(`${settings.apiKey}:X`).toString("base64")}`
  const hasAttachment = Boolean(
    input.screenshotData?.startsWith("data:")
  )
  const logContext = {
    domain: settings.domain,
    titlePreview: input.title.substring(0, 50),
    priority: settings.priority,
    status: settings.status,
    hasWorkspace: !!settings.workspaceId,
    hasApiKey: !!settings.apiKey,
  }

  if (hasAttachment) {
    const multipart = buildMultipartBody(input, session, settings, log)
    log.info("Calling Freshservice API with attachment", {
      ...logContext,
      screenshotSize: multipart.screenshotSize,
    })
    return fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: authorization },
      body: multipart.body,
    })
  }

  log.info("Calling Freshservice API with JSON", logContext)
  return fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJsonBody(input, session, settings)),
  })
}

function upstreamErrorMessage(status: number, data: unknown): string {
  if (status === 401) return "Invalid API key or unauthorized"
  if (status === 404) {
    return "Domain not found. Please check FRESHSERVICE_DOMAIN setting"
  }
  if (status >= 500) {
    return "Freshservice server error. Please try again later"
  }
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message
  }
  return `API returned ${status}`
}

async function requireSuccessfulResponse(
  response: Response,
  log: ActionLogger
): Promise<void> {
  if (response.ok) return
  const errorText = await response.text().catch(() => "")
  let errorData: unknown
  try {
    errorData = JSON.parse(errorText) as unknown
  } catch {
    errorData = { message: errorText || `HTTP ${response.status}` }
  }
  log.error("Freshservice API error", {
    status: response.status,
    statusText: response.statusText,
    error: sanitizeForLogging(errorData),
  })
  throw ErrorFactories.externalServiceError(
    "Freshservice",
    new Error(upstreamErrorMessage(response.status, errorData))
  )
}

export function parseFreshserviceTicketId(
  ticket: FreshserviceTicketData
): number | null {
  const ticketId =
    typeof ticket.id === "string"
      ? Number.parseInt(ticket.id, 10)
      : ticket.id
  return !ticketId || Number.isNaN(ticketId) || ticketId <= 0
    ? null
    : ticketId
}

export async function createFreshserviceTicketAction(
  formData: FormData
): Promise<ActionState<FreshserviceTicketResponse>> {
  const requestId = generateRequestId()
  const timer = startTimer("createFreshserviceTicket")
  const log = createLogger({ requestId, action: "createFreshserviceTicket" })

  try {
    const input = readTicketInput(formData)
    log.info("Action started: Creating Freshservice ticket", {
      titleLength: input.title.length,
      descriptionLength: input.description.length,
      hasScreenshot: !!input.screenshotData,
    })

    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    const settings = await Settings.getFreshservice()
    validateSettings(settings, log)

    const response = await sendFreshserviceRequest({
      input,
      log,
      session,
      settings,
    })
    await requireSuccessfulResponse(response, log)
    const apiResponse = (await response.json()) as FreshserviceApiResponse
    const ticket = apiResponse.ticket
    const ticketId = ticket ? parseFreshserviceTicketId(ticket) : null
    if (!ticket || !ticketId) {
      log.error("Invalid ticket data in response", {
        responseKeys: Object.keys(apiResponse),
        rawTicketId: ticket?.id,
      })
      throw ErrorFactories.externalServiceError(
        "Freshservice",
        new Error(ticket ? "Invalid ticket response" : "Invalid ticket response - no ticket data")
      )
    }

    const ticketUrl =
      `https://${settings.domain}.freshservice.com/support/tickets/${ticketId}`
    log.info("Freshservice ticket created successfully", {
      ticketUrl,
      ticketId,
      ticketNumber: ticket.display_id || ticketId,
      rawTicketId: ticket.id,
    })
    timer({ status: "success", ticketId })
    return createSuccess(
      { ticket_url: ticketUrl, ticket_id: ticketId },
      "Ticket created successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to create ticket. Please try again or contact support.",
      {
        context: "createFreshserviceTicket",
        requestId,
        operation: "createFreshserviceTicket",
        metadata: {
          titleLength: formData.get("title")?.toString()?.length,
          hasScreenshot: !!formData.get("screenshotData"),
        },
      }
    )
  }
}
