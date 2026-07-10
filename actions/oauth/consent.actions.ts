/**
 * OAuth Consent Server Actions
 * Approve or deny OAuth authorization requests.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Since oidc-provider requires Node.js req/res for interactionResult,
 * these actions store the consent decision and redirect back to the
 * provider's interaction endpoint which reads the stored decision.
 *
 * Consent decisions are stored in the database for multi-instance safety.
 */

"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils"
import { executeQuery } from "@/lib/db/drizzle-client"
import { oauthConsentDecisions } from "@/lib/db/schema"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import type { ActionState } from "@/types/actions-types"

// ============================================
// Types
// ============================================

interface ConsentResult {
  redirectTo: string
}

// NOTE: getConsentDecision moved to lib/oauth/consent-decisions.ts as
// consumeConsentDecision (REV-COR-050). As an exported "use server" function it
// was a public, unauthenticated endpoint that could destructively consume any
// user's pending consent decision by uid. Its legitimate consumer is the OAuth
// interaction route handler (a server-only module), not the action surface.

// ============================================
// Core Consent Processing
// ============================================

async function processConsent(
  interactionUid: string,
  approved: boolean,
  grantedScopes: string[] = []
): Promise<ActionState<ConsentResult>> {
  const actionName = approved ? "approveConsent" : "denyConsent"
  const requestId = generateRequestId()
  const timer = startTimer(actionName)
  const log = createLogger({ requestId, action: actionName })

  try {
    const session = await getServerSession()
    if (!session?.sub) {
      throw ErrorFactories.authNoSession()
    }

    log.info(`Processing consent ${approved ? "approval" : "denial"}`, { interactionUid })

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.authNoSession()
    }

    // Store consent decision in database (5 min TTL)
    await executeQuery(
      (db) =>
        db
          .insert(oauthConsentDecisions)
          .values({
            uid: interactionUid,
            userId,
            approved,
            scopes: grantedScopes,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          }),
      "storeConsentDecision"
    )

    const issuer = getIssuerUrl()
    const path = approved ? "login" : "abort"
    const redirectTo = `${issuer}/api/oauth/interaction/${interactionUid}/${path}`

    timer({ status: "success" })
    log.info(`Consent ${approved ? "approved" : "denied"}`, { interactionUid, userId })

    return createSuccess(
      { redirectTo },
      approved ? "Authorization granted" : "Authorization denied"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, `Failed to process consent`, {
      context: actionName,
      requestId,
      operation: actionName,
    })
  }
}

// ============================================
// Public Actions
// ============================================

export async function approveConsent(
  interactionUid: string,
  grantedScopes: string[]
): Promise<ActionState<ConsentResult>> {
  return processConsent(interactionUid, true, grantedScopes)
}

export async function denyConsent(
  interactionUid: string
): Promise<ActionState<ConsentResult>> {
  return processConsent(interactionUid, false)
}
