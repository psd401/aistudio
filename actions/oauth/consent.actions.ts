/**
 * OAuth Consent Server Actions
 * Approve or deny OAuth authorization requests.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Since oidc-provider requires Node.js req/res for interactionResult,
 * these actions store the consent decision and redirect back to the
 * provider's interaction endpoint which reads the stored decision.
 */

"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import type { ActionState } from "@/types/actions-types"

// ============================================
// In-Memory Consent Store (ephemeral)
// ============================================

interface ConsentDecision {
  approved: boolean
  userId: number
  scopes: string[]
  createdAt: number
}

const consentDecisions = new Map<string, ConsentDecision>()

// Cleanup expired decisions (older than 5 min)
function cleanupDecisions(): void {
  const now = Date.now()
  for (const [key, decision] of consentDecisions) {
    if (now - decision.createdAt > 5 * 60 * 1000) {
      consentDecisions.delete(key)
    }
  }
}

export function getConsentDecision(uid: string): ConsentDecision | undefined {
  cleanupDecisions()
  const decision = consentDecisions.get(uid)
  if (decision) {
    consentDecisions.delete(uid) // consume once
  }
  return decision
}

// ============================================
// Types
// ============================================

interface ConsentResult {
  redirectTo: string
}

// ============================================
// Approve Consent
// ============================================

export async function approveConsent(
  interactionUid: string,
  grantedScopes: string[]
): Promise<ActionState<ConsentResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("approveConsent")
  const log = createLogger({ requestId, action: "approveConsent" })

  try {
    const session = await getServerSession()
    if (!session?.sub) {
      throw ErrorFactories.authNoSession()
    }

    log.info("Processing consent approval", { interactionUid })

    // Look up userId from cognitoSub
    const { getUserIdByCognitoSubAsNumber } = await import("@/lib/db/drizzle/utils")
    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.authNoSession()
    }

    // Store the consent decision
    consentDecisions.set(interactionUid, {
      approved: true,
      userId,
      scopes: grantedScopes,
      createdAt: Date.now(),
    })

    // Redirect back to the OIDC interaction endpoint
    const issuer =
      process.env.NEXTAUTH_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000"

    const redirectTo = `${issuer}/api/oauth/interaction/${interactionUid}/login`

    timer({ status: "success" })
    log.info("Consent approved", { interactionUid, userId })

    return createSuccess({ redirectTo }, "Authorization granted")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to process consent", {
      context: "approveConsent",
      requestId,
      operation: "approveConsent",
    })
  }
}

// ============================================
// Deny Consent
// ============================================

export async function denyConsent(
  interactionUid: string
): Promise<ActionState<ConsentResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("denyConsent")
  const log = createLogger({ requestId, action: "denyConsent" })

  try {
    const session = await getServerSession()
    if (!session?.sub) {
      throw ErrorFactories.authNoSession()
    }

    log.info("Processing consent denial", { interactionUid })

    const { getUserIdByCognitoSubAsNumber } = await import("@/lib/db/drizzle/utils")
    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.authNoSession()
    }

    // Store the denial decision
    consentDecisions.set(interactionUid, {
      approved: false,
      userId,
      scopes: [],
      createdAt: Date.now(),
    })

    const issuer =
      process.env.NEXTAUTH_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000"

    const redirectTo = `${issuer}/api/oauth/interaction/${interactionUid}/abort`

    timer({ status: "success" })
    log.info("Consent denied", { interactionUid })

    return createSuccess({ redirectTo }, "Authorization denied")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to process denial", {
      context: "denyConsent",
      requestId,
      operation: "denyConsent",
    })
  }
}
