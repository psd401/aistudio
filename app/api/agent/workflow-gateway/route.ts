import { NextRequest, NextResponse } from "next/server"
import {
  CALLER_BOUND_MARKER,
  getCallerBoundArgumentNames,
  WorkflowGatewayError,
  workflowGatewayDependencies,
  type WorkflowGatewayConfig,
  type WorkflowGatewayTool,
} from "@/lib/agent-services/workflow-gateway"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretJson } from "@/lib/agent-workspace/secrets-manager"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import {
  acquireResourceAdmission,
  finishResourceAdmission,
  isCapacityDenial,
} from "@/lib/resource-admission"

const log = createLogger({ module: "agent-workflow-gateway-broker" })
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_ARGUMENT_STRING_LENGTH = 20_000
const WORKFLOW_GATEWAY_LIMITS = {
  contextActive: 1,
  ownerActive: 2,
  globalActive: 24,
  contextHourlyUnits: 30,
  ownerHourlyUnits: 60,
  globalHourlyUnits: 1_000,
  leaseMs: 3 * 60 * 1000,
} as const

interface ListToolsRequest {
  action: "list-tools"
}

interface CallToolRequest {
  arguments: Record<string, unknown>
  toolName: string
}

type GatewayRequest = ListToolsRequest | CallToolRequest

function environment(): string {
  return process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function containsOversizedString(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === "string") {
      if (current.length > MAX_ARGUMENT_STRING_LENGTH) return true
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item)
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) pending.push(item)
    }
  }
  return false
}

function requestSize(body: Record<string, unknown>): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(body), "utf8")
  } catch {
    return null
  }
}

function invalidOperation(): NextResponse {
  return NextResponse.json({ error: "Invalid gateway operation" }, { status: 400 })
}

function hasOversizedDeclaredLength(request: NextRequest): boolean {
  const declaredLength = request.headers.get("content-length")
  return Boolean(
    declaredLength &&
      /^\d+$/.test(declaredLength) &&
      Number(declaredLength) > MAX_REQUEST_BYTES
  )
}

function isListToolsRequest(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body)
  return (
    keys.length === 1 &&
    keys[0] === "action" &&
    body.action === "list-tools"
  )
}

function parseCallToolRequest(
  body: Record<string, unknown>
): CallToolRequest | null {
  const keys = Object.keys(body)
  if (
    keys.length !== 2 ||
    !keys.includes("toolName") ||
    !keys.includes("arguments") ||
    typeof body.toolName !== "string" ||
    body.toolName.length === 0 ||
    body.toolName.length > 256 ||
    !isRecord(body.arguments) ||
    containsOversizedString(body.arguments)
  ) {
    return null
  }
  return { toolName: body.toolName, arguments: body.arguments }
}

function parseGatewayRequestBody(
  raw: unknown
): { value: GatewayRequest } | { response: NextResponse } {
  if (!isRecord(raw)) return { response: invalidOperation() }
  const size = requestSize(raw)
  if (size === null) return { response: invalidOperation() }
  if (size > MAX_REQUEST_BYTES) {
    return {
      response: NextResponse.json({ error: "Request is too large" }, { status: 413 }),
    }
  }
  if (isListToolsRequest(raw)) return { value: { action: "list-tools" } }
  const call = parseCallToolRequest(raw)
  return call ? { value: call } : { response: invalidOperation() }
}

async function readGatewayRequest(
  request: NextRequest
): Promise<{ value: GatewayRequest } | { response: NextResponse }> {
  if (hasOversizedDeclaredLength(request)) {
    return {
      response: NextResponse.json({ error: "Request is too large" }, { status: 413 }),
    }
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return {
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    }
  }
  return parseGatewayRequestBody(raw)
}

async function loadGatewayConfig(): Promise<
  { value: WorkflowGatewayConfig } | { response: NextResponse }
> {
  const config = await getSecretJson<{ url?: unknown; token?: unknown }>(
    `psd-agent/${environment()}/agent-gateway`
  )
  if (
    typeof config?.url !== "string" ||
    !config.url ||
    typeof config.token !== "string" ||
    !config.token ||
    config.token.length > 8192
  ) {
    return {
      response: NextResponse.json(
        { error: "Workflow gateway is not configured" },
        { status: 503 }
      ),
    }
  }

  let gatewayUrl: URL
  try {
    gatewayUrl = new URL(config.url)
  } catch {
    return {
      response: NextResponse.json(
        { error: "Workflow gateway is misconfigured" },
        { status: 503 }
      ),
    }
  }
  if (
    gatewayUrl.protocol !== "https:" ||
    gatewayUrl.username ||
    gatewayUrl.password
  ) {
    return {
      response: NextResponse.json(
        { error: "Workflow gateway is misconfigured" },
        { status: 503 }
      ),
    }
  }
  return { value: { url: gatewayUrl.toString(), token: config.token } }
}

async function acquireGatewayLease(
  ownerEmail: string,
  contextKey: string,
  requestId: string
): Promise<{ leaseId: string | null } | { response: NextResponse }> {
  const admission = await acquireResourceAdmission({
    kind: "workflow-gateway-calls",
    ownerKey: ownerEmail,
    contextKey,
    idempotencyKey: requestId,
    units: 1,
    limits: WORKFLOW_GATEWAY_LIMITS,
  })
  if (!admission.allowed && !isCapacityDenial(admission)) {
    return {
      response: NextResponse.json({ error: "Duplicate request" }, { status: 409 }),
    }
  }
  if (!admission.allowed) {
    log.warn("Workflow gateway over threshold (observe-only — request allowed)", {
      requestId,
      reason: admission.reason,
    })
  }
  return { leaseId: admission.allowed ? admission.leaseId : null }
}

async function settleGatewayLease(
  leaseId: string | null,
  requestId: string
): Promise<void> {
  if (!leaseId) return
  try {
    await finishResourceAdmission(leaseId)
  } catch (error) {
    log.error(
      "Workflow gateway admission settlement failed",
      sanitizeForLogging({
        requestId,
        leaseId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }
}

function findTool(
  tools: WorkflowGatewayTool[],
  toolName: string
): WorkflowGatewayTool | null {
  return tools.find((tool) => tool.name === toolName) ?? null
}

function bindCallerArguments(
  args: Record<string, unknown>,
  callerArgumentNames: string[],
  ownerEmail: string
): Record<string, unknown> {
  const result = Object.assign(
    Object.create(null) as Record<string, unknown>,
    args
  )
  for (const name of callerArgumentNames) result[name] = ownerEmail
  return result
}

function unmarkedSubmitResponse(toolName: string): NextResponse {
  return NextResponse.json(
    {
      error:
        `Gateway submit tool "${toolName}" is missing a ${CALLER_BOUND_MARKER} ` +
        "argument marker; ask the workflow owner to mark the verified caller field.",
    },
    { status: 400 }
  )
}

async function executeCall(options: {
  config: WorkflowGatewayConfig
  gatewayRequest: CallToolRequest
  ownerEmail: string
  requestId: string
  signal: AbortSignal
}): Promise<NextResponse> {
  const { config, gatewayRequest, ownerEmail, requestId, signal } = options
  const tools = await workflowGatewayDependencies.listTools(
    config,
    undefined,
    signal
  )
  const tool = findTool(tools, gatewayRequest.toolName)
  if (!tool) {
    return NextResponse.json(
      { error: "Gateway tool is not available in the live roster" },
      { status: 400 }
    )
  }
  const callerArgumentNames = getCallerBoundArgumentNames(tool.inputSchema)
  if (
    gatewayRequest.toolName.startsWith("submit_") &&
    callerArgumentNames.length === 0
  ) {
    return unmarkedSubmitResponse(gatewayRequest.toolName)
  }
  const args = bindCallerArguments(
    gatewayRequest.arguments,
    callerArgumentNames,
    ownerEmail
  )
  const result = await workflowGatewayDependencies.execute(
    config,
    gatewayRequest.toolName,
    args,
    undefined,
    signal
  )
  log.info(
    "Owner-bound workflow gateway operation completed",
    sanitizeForLogging({
      requestId,
      ownerEmail,
      toolName: gatewayRequest.toolName,
      isError: result.isError,
      callerBoundArguments: callerArgumentNames,
    })
  )
  return NextResponse.json(result)
}

async function executeGatewayRequest(options: {
  config: WorkflowGatewayConfig
  gatewayRequest: GatewayRequest
  leaseId: string | null
  ownerEmail: string
  requestId: string
  signal: AbortSignal
}): Promise<NextResponse> {
  const { config, gatewayRequest, leaseId, ownerEmail, requestId, signal } =
    options
  try {
    if ("action" in gatewayRequest) {
      const tools = await workflowGatewayDependencies.listTools(
        config,
        undefined,
        signal
      )
      return NextResponse.json({ tools })
    }
    return await executeCall({
      config,
      gatewayRequest,
      ownerEmail,
      requestId,
      signal,
    })
  } catch (error) {
    const toolName =
      "toolName" in gatewayRequest ? gatewayRequest.toolName : "tools/list"
    log.warn(
      "Owner-bound workflow gateway operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    if (error instanceof WorkflowGatewayError && error.code === "tool") {
      return NextResponse.json(
        { error: "Gateway tool rejected the operation", detail: error.detail },
        { status: 422 }
      )
    }
    return NextResponse.json({ error: "Workflow gateway failed" }, { status: 502 })
  } finally {
    await settleGatewayLease(leaseId, requestId)
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const parsed = await readGatewayRequest(request)
  if ("response" in parsed) return parsed.response
  const config = await loadGatewayConfig()
  if ("response" in config) return config.response
  const admission = await acquireGatewayLease(
    context.ownerEmail,
    `${context.sessionId}:${context.nonce}`,
    requestId
  )
  if ("response" in admission) return admission.response
  return executeGatewayRequest({
    config: config.value,
    gatewayRequest: parsed.value,
    ownerEmail: context.ownerEmail,
    requestId,
    signal: request.signal,
    leaseId: admission.leaseId,
  })
}
