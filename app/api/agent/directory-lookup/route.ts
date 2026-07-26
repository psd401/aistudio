/**
 * Directory identity resolution for the agent (#1239).
 *
 * Resolves a district email address, or a Google Chat `users/{id}`, to the
 * real person — name, title, department — so the agent stops guessing who
 * someone is from an address local-part or an opaque sender id.
 *
 * WHY THIS IS A SERVER ROUTE. The lookup needs a Google token, and #1353
 * established that the model runtime never holds one. So the token is minted
 * here, used here, and never leaves: the agent receives only a shaped person
 * record. The owner is taken from the proxy-signed invocation context, NOT
 * from the request body, so the model cannot assert whose directory access it
 * is borrowing.
 *
 * Agent-slot only: `directory.readonly` is already in AGENT_DWD_SCOPES, so
 * this needs no consent flow, no new scope, and no admin role on the service
 * account.
 *
 * TARGETED RESOLUTION ONLY — there is deliberately no "list the directory"
 * operation here. See lib/agent-workspace/directory-lookup.ts for why that
 * matters given the directory contains student records.
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { mintAgentWorkspaceTokenViaBoundary } from "@/lib/agent-workspace/mint-client"
import {
  AccountNotProvisionedError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"
import {
  DirectoryError,
  resolveEmail,
  resolvePersonId,
} from "@/lib/agent-workspace/directory-lookup"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-directory-lookup" })

interface DirectoryRequest {
  email?: string
  chatId?: string
  noCache?: boolean
}

/**
 * Exact-shape validation. Unknown keys are rejected rather than ignored so a
 * future field cannot be smuggled past review, matching the isCommand()
 * pattern in workspace-execute.
 */
function isDirectoryRequest(value: unknown): value is DirectoryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const allowed = new Set(["email", "chatId", "noCache"])
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return false
  if ("email" in candidate && typeof candidate.email !== "string") return false
  if ("chatId" in candidate && typeof candidate.chatId !== "string") return false
  if ("noCache" in candidate && typeof candidate.noCache !== "boolean") return false
  // Exactly one selector — an ambiguous request is a bug in the caller, not
  // something to silently pick a winner for.
  const hasEmail = typeof candidate.email === "string" && candidate.email.length > 0
  const hasChatId = typeof candidate.chatId === "string" && candidate.chatId.length > 0
  return hasEmail !== hasChatId
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled", "email-task"],
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
  if (!isDirectoryRequest(body)) {
    return NextResponse.json(
      { error: "Provide exactly one of email or chatId" },
      { status: 400 },
    )
  }

  try {
    const { accessToken } = await mintAgentWorkspaceTokenViaBoundary(
      context.ownerEmail,
    )
    // ownerKey partitions the process-global lookup cache. It MUST come from
    // the signed context, never the body — that is what stops one agent's
    // authorized result being served to another.
    const opts = {
      noCache: body.noCache === true,
      ownerKey: context.ownerEmail,
    }
    const result = body.email
      ? await resolveEmail(body.email, accessToken, opts)
      : await resolvePersonId(body.chatId as string, accessToken, opts)

    log.info(
      "Directory lookup completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        mode: context.mode,
        selector: body.email ? "email" : "chatId",
        found: result.found,
        cached: result.cached === true,
      }),
    )
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof AccountNotProvisionedError) {
      return NextResponse.json(
        {
          status: "account-not-provisioned",
          error: "Agent account is being provisioned",
        },
        { status: 409 },
      )
    }
    if (error instanceof InvalidOwnerError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof DirectoryError) {
      // These map to distinct agent-facing outcomes. In particular
      // DIRECTORY_SHARING_DISABLED is an ADMIN CONSOLE state that no retry or
      // code change fixes, and it is indistinguishable from a permissions bug
      // unless the response names it — that ambiguity cost real diagnosis
      // time on #1239.
      const status =
        error.code === "TRANSPORT"
          ? 502
          : error.code === "INVALID_INPUT"
            ? 400
            : error.code === "DIRECTORY_SHARING_DISABLED" ||
                error.code === "INSUFFICIENT_SCOPE"
              ? 409
              : 502
      log.warn(
        "Directory lookup failed",
        sanitizeForLogging({
          requestId,
          ownerEmail: context.ownerEmail,
          code: error.code,
          error: error.message,
        }),
      )
      return NextResponse.json(
        { status: error.code, error: error.message },
        { status },
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      "Directory lookup errored",
      sanitizeForLogging({ requestId, ownerEmail: context.ownerEmail, error: message }),
    )
    return NextResponse.json({ error: "Directory lookup failed" }, { status: 502 })
  }
}
