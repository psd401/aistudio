"use server"

import { createHash } from "node:crypto"
import { and, eq, isNull, sql } from "drizzle-orm"
import { createLogger, generateRequestId, sanitizeForLogging, startTimer } from "@/lib/logger"
import { createSuccess, handleError } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import {
  storeAistudioOAuthTokens,
  type AistudioOAuthTokenData,
} from "@/lib/agent-workspace/secrets-manager"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { getServerSession } from "@/lib/auth/server-session"
import {
  AISTUDIO_OPENCLAW_CLIENT_ID,
  AISTUDIO_OPENCLAW_SCOPES,
} from "@/lib/oauth/openclaw-client"

function redirectUri(): string {
  return `${getIssuerUrl()}/agent-connect-aistudio/callback`
}

function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

async function isAuthenticatedOwner(ownerEmail: string): Promise<boolean> {
  const session = await getServerSession()
  return (
    typeof session?.email === "string" &&
    session.email.trim().toLowerCase() === ownerEmail.trim().toLowerCase()
  )
}

export interface AistudioConsentVerifyResult {
  valid: boolean
  ownerEmail?: string
  oauthUrl?: string
  error?: string
}

export async function verifyAistudioConsentAndGetOAuthUrl(
  token: string
): Promise<ActionState<AistudioConsentVerifyResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("verifyAistudioConsent")
  const log = createLogger({ requestId, action: "verifyAistudioConsent" })
  try {
    const payload = await verifyConsentToken(token)
    if (!payload || payload.kind !== "aistudio") {
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error: "This consent link is invalid or for a different connection.",
      })
    }
    if (!(await isAuthenticatedOwner(payload.sub))) {
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error:
          "Sign in as the AI Studio owner named in this link to connect OpenClaw.",
      })
    }
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [row] = await executeQuery(
      (db) =>
        db
          .select({
            codeVerifier: psdAgentWorkspaceConsentNonces.codeVerifier,
            ownerEmail: psdAgentWorkspaceConsentNonces.ownerEmail,
          })
          .from(psdAgentWorkspaceConsentNonces)
          .where(
            sql`${psdAgentWorkspaceConsentNonces.nonce} = ${payload.nonce}
                AND ${psdAgentWorkspaceConsentNonces.tokenKind} = 'aistudio'
                AND ${psdAgentWorkspaceConsentNonces.consumedAt} IS NULL
                AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
          )
          .limit(1),
      "lookupAistudioConsentNonce"
    )
    if (
      !row?.codeVerifier ||
      row.ownerEmail.toLowerCase() !== payload.sub.toLowerCase()
    ) {
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error:
          "This link expired or was already used. Ask your agent for a new link.",
      })
    }
    const params = new URLSearchParams({
      client_id: AISTUDIO_OPENCLAW_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: AISTUDIO_OPENCLAW_SCOPES.join(" "),
      state: payload.nonce,
      code_challenge: s256Challenge(row.codeVerifier),
      code_challenge_method: "S256",
    })
    timer({ status: "success" })
    log.info(
      "AI Studio consent verified",
      sanitizeForLogging({ ownerEmail: payload.sub })
    )
    return createSuccess({
      valid: true,
      ownerEmail: payload.sub,
      oauthUrl: `${getIssuerUrl()}/api/oauth/auth?${params.toString()}`,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to verify AI Studio consent link", {
      context: "verifyAistudioConsent",
      requestId,
      operation: "verifyAistudioConsent",
    })
  }
}

export interface AistudioCallbackResult {
  success: boolean
  ownerEmail?: string
  error?: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  scope?: string
  expires_in?: number
  error?: string
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export async function handleAistudioCallback(
  code: string,
  state: string
): Promise<ActionState<AistudioCallbackResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("handleAistudioCallback")
  const log = createLogger({ requestId, action: "handleAistudioCallback" })
  try {
    // Treat the server-side, single-use nonce record as the state validator.
    // A format check is not an authorization boundary: only an exact,
    // unconsumed, unexpired nonce issued by this application may proceed.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [row] = await executeQuery(
      (db) =>
        db
          .select({
            ownerEmail: psdAgentWorkspaceConsentNonces.ownerEmail,
            tokenKind: psdAgentWorkspaceConsentNonces.tokenKind,
            codeVerifier: psdAgentWorkspaceConsentNonces.codeVerifier,
          })
          .from(psdAgentWorkspaceConsentNonces)
          .where(
            sql`${psdAgentWorkspaceConsentNonces.nonce} = ${state}
                AND ${psdAgentWorkspaceConsentNonces.consumedAt} IS NULL
                AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
          )
          .limit(1),
      "lookupAistudioCallbackNonce"
    )
    if (!row || row.tokenKind !== "aistudio" || !row.codeVerifier) {
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error:
          "This connection link was already used or expired. Ask your agent for a new one.",
      })
    }
    if (!(await isAuthenticatedOwner(row.ownerEmail))) {
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error:
          "This AI Studio consent link belongs to a different signed-in user.",
      })
    }

    const tokenResponse = await fetch(`${getIssuerUrl()}/api/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: AISTUDIO_OPENCLAW_CLIENT_ID,
        code,
        redirect_uri: redirectUri(),
        code_verifier: row.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const tokenData = (await readJsonObject(tokenResponse)) as TokenResponse
    if (
      !tokenResponse.ok ||
      typeof tokenData.access_token !== "string" ||
      typeof tokenData.refresh_token !== "string" ||
      typeof tokenData.expires_in !== "number"
    ) {
      log.warn("AI Studio authorization-code exchange failed", {
        status: tokenResponse.status,
        error: tokenData.error,
      })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "AI Studio rejected the authorization. Please request a new link.",
      })
    }

    const userinfoResponse = await fetch(
      `${getIssuerUrl()}/api/oauth/userinfo`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }
    )
    const userinfo = await readJsonObject(userinfoResponse)
    const authorizedEmail =
      typeof userinfo.email === "string" ? userinfo.email.toLowerCase() : null
    if (
      !userinfoResponse.ok ||
      authorizedEmail !== row.ownerEmail.toLowerCase()
    ) {
      log.warn("AI Studio OAuth identity did not match consent owner", {
        userinfoStatus: userinfoResponse.status,
        hasEmail: authorizedEmail !== null,
      })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error:
          "The signed-in AI Studio account does not match this connection link.",
      })
    }

    const obtainedAt = new Date()
    const tokens: AistudioOAuthTokenData = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: "Bearer",
      scope:
        typeof tokenData.scope === "string"
          ? tokenData.scope
          : AISTUDIO_OPENCLAW_SCOPES.join(" "),
      obtained_at: obtainedAt.toISOString(),
      expires_at: new Date(
        obtainedAt.getTime() + tokenData.expires_in * 1000
      ).toISOString(),
    }
    await storeAistudioOAuthTokens(row.ownerEmail, tokens)
    const consumed = await executeQuery(
      (db) =>
        db
          .update(psdAgentWorkspaceConsentNonces)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(psdAgentWorkspaceConsentNonces.nonce, state),
              isNull(psdAgentWorkspaceConsentNonces.consumedAt)
            )
          )
          .returning({ nonce: psdAgentWorkspaceConsentNonces.nonce }),
      "consumeAistudioConsentNonce"
    )
    if (consumed.length !== 1) {
      throw new Error("AI Studio consent nonce was consumed concurrently")
    }
    timer({ status: "success" })
    log.info(
      "AI Studio connected to OpenClaw",
      sanitizeForLogging({ ownerEmail: row.ownerEmail })
    )
    return createSuccess({ success: true, ownerEmail: row.ownerEmail })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to complete AI Studio connection", {
      context: "handleAistudioCallback",
      requestId,
      operation: "handleAistudioCallback",
    })
  }
}
