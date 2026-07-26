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
import { executeTransaction } from "@/lib/db/drizzle-client"
import { oauthConsentDecisions } from "@/lib/db/schema"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import type { ActionState } from "@/types/actions-types"
import { count, eq, lt, sql } from "drizzle-orm"
import { headers } from "next/headers"
import { getOAuthInteractionSummary } from "@/lib/oauth/interaction-service"

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
  approved: boolean
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

    log.info(`Processing consent ${approved ? "approval" : "denial"}`)

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.authNoSession()
    }

    // The uid comes from the browser, but oidc-provider's signed interaction
    // cookie is authoritative. Refuse arbitrary or expired identifiers before
    // allocating a durable decision row.
    const interaction = await getOAuthInteractionSummary(
      interactionUid,
      new Headers(await headers())
    )
    if (
      !interaction
      || interaction.uid !== interactionUid
      || interaction.promptName !== "consent"
    ) {
      throw ErrorFactories.validationFailed([{
        field: "interactionUid",
        message: "OAuth interaction is invalid or expired",
        value: interactionUid,
      }])
    }

    // Bound outstanding decisions per authenticated user. The advisory lock
    // makes expiry cleanup + count + insert one atomic reservation.
    await executeTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(1129270867, ${userId})`
        )
        await tx
          .delete(oauthConsentDecisions)
          .where(lt(oauthConsentDecisions.expiresAt, new Date()))
        const [outstanding] = await tx
          .select({ value: count() })
          .from(oauthConsentDecisions)
          .where(eq(oauthConsentDecisions.userId, userId))
        if ((outstanding?.value ?? 0) >= 10) {
          throw ErrorFactories.bizQuotaExceeded(
            "OAuth consent decisions",
            10,
            outstanding?.value ?? 0
          )
        }
        await tx
          .insert(oauthConsentDecisions)
          .values({
            uid: interactionUid,
            userId,
            approved,
            // The completion route derives grant scopes from oidc-provider's
            // signed interaction state, never from browser-supplied values.
            scopes: [],
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          })
      },
      "storeConsentDecision"
    )

    const issuer = getIssuerUrl()
    const path = approved ? "consent" : "abort"
    const redirectTo =
      `${issuer}/oauth/authorize/interaction/${interactionUid}/${path}`

    timer({ status: "success" })
    log.info(`Consent ${approved ? "approved" : "denied"}`, {
      userId,
    })

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
  interactionUid: string
): Promise<ActionState<ConsentResult>> {
  return processConsent(interactionUid, true)
}

export async function denyConsent(
  interactionUid: string
): Promise<ActionState<ConsentResult>> {
  return processConsent(interactionUid, false)
}
