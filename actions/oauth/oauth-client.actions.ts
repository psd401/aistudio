/**
 * OAuth Client Management Server Actions
 * CRUD operations for OAuth2 client applications.
 * Admin-only. Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess, ErrorFactories } from "@/lib/error-utils"
import { requireRole } from "@/lib/auth/role-helpers"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils"
import { executeQuery } from "@/lib/db/drizzle-client"
import { oauthClients } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { randomBytes, randomUUID } from "node:crypto"
import type { ActionState } from "@/types"

// ============================================
// Types
// ============================================

export interface OAuthClientRow {
  id: number
  clientId: string
  clientName: string
  redirectUris: string[]
  allowedScopes: string[]
  grantTypes: string[]
  tokenEndpointAuthMethod: string
  requirePkce: boolean
  accessTokenTtl: number
  refreshTokenTtl: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreateOAuthClientInput {
  clientName: string
  redirectUris: string[]
  allowedScopes: string[]
  tokenEndpointAuthMethod?: "none" | "client_secret_post"
  requirePkce?: boolean
  accessTokenTtl?: number
  refreshTokenTtl?: number
}

export interface CreateOAuthClientResult {
  client: OAuthClientRow
  clientSecret?: string // Only returned on creation, never again
}

// ============================================
// List OAuth Clients
// ============================================

export async function listOAuthClients(): Promise<ActionState<OAuthClientRow[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listOAuthClients")
  const log = createLogger({ requestId, action: "listOAuthClients" })

  try {
    await requireRole("administrator")

    const clients = await executeQuery(
      (db) =>
        db
          .select({
            id: oauthClients.id,
            clientId: oauthClients.clientId,
            clientName: oauthClients.clientName,
            redirectUris: oauthClients.redirectUris,
            allowedScopes: oauthClients.allowedScopes,
            grantTypes: oauthClients.grantTypes,
            tokenEndpointAuthMethod: oauthClients.tokenEndpointAuthMethod,
            requirePkce: oauthClients.requirePkce,
            accessTokenTtl: oauthClients.accessTokenTtl,
            refreshTokenTtl: oauthClients.refreshTokenTtl,
            isActive: oauthClients.isActive,
            createdAt: oauthClients.createdAt,
            updatedAt: oauthClients.updatedAt,
          })
          .from(oauthClients)
          .orderBy(oauthClients.createdAt),
      "listOAuthClients"
    )

    timer({ status: "success" })
    log.info("Listed OAuth clients", { count: clients.length })

    return createSuccess(
      clients.map((c) => ({
        ...c,
        redirectUris: c.redirectUris as string[],
        allowedScopes: c.allowedScopes as string[],
        grantTypes: c.grantTypes as string[],
      })),
      "OAuth clients loaded"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to list OAuth clients", {
      context: "listOAuthClients",
      requestId,
      operation: "listOAuthClients",
    })
  }
}

// ============================================
// Create OAuth Client
// ============================================

// ============================================
// Redirect URI Validation
// ============================================

function validateRedirectUris(uris: string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const isProduction = process.env.NODE_ENV === "production"

  for (const uri of uris) {
    let parsed: URL
    try {
      parsed = new URL(uri)
    } catch {
      errors.push(`Invalid URL format: ${uri}`)
      continue
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push(`Invalid protocol (must be http/https): ${uri}`)
      continue
    }

    // Production: enforce HTTPS except localhost
    if (isProduction && parsed.protocol === "http:") {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
        errors.push(`Production requires HTTPS: ${uri}`)
      }
    }

    // No wildcards in hostname
    if (parsed.hostname.includes("*")) {
      errors.push(`Wildcards not allowed in hostname: ${uri}`)
    }

    // Fragment not allowed per OAuth spec
    if (parsed.hash) {
      errors.push(`Fragments not allowed in redirect URI: ${uri}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// ============================================
// Create OAuth Client
// ============================================

export async function createOAuthClient(
  input: CreateOAuthClientInput
): Promise<ActionState<CreateOAuthClientResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("createOAuthClient")
  const log = createLogger({ requestId, action: "createOAuthClient" })

  try {
    await requireRole("administrator")

    const session = await getServerSession()
    const userId = session?.sub ? await getUserIdByCognitoSubAsNumber(session.sub) : null

    log.info("Creating OAuth client", { name: sanitizeForLogging(input.clientName) })

    // Validate redirect URIs
    if (input.redirectUris.length === 0) {
      throw ErrorFactories.invalidInput("redirectUris", input.redirectUris, "At least one redirect URI is required")
    }
    const uriValidation = validateRedirectUris(input.redirectUris)
    if (!uriValidation.valid) {
      log.warn("Invalid redirect URIs", { errors: uriValidation.errors })
      throw ErrorFactories.invalidInput(
        "redirectUris",
        input.redirectUris,
        uriValidation.errors.join("; ")
      )
    }

    const clientId = randomUUID()
    const isConfidential = input.tokenEndpointAuthMethod === "client_secret_post"

    let clientSecret: string | undefined
    let clientSecretHash: string | null = null

    if (isConfidential) {
      clientSecret = `cs-${randomBytes(32).toString("hex")}`
      const argon2 = await import("argon2")
      clientSecretHash = await argon2.hash(clientSecret)
    }

    const [created] = await executeQuery(
      (db) =>
        db
          .insert(oauthClients)
          .values({
            clientId,
            clientName: input.clientName.trim(),
            clientSecretHash,
            redirectUris: input.redirectUris,
            allowedScopes: input.allowedScopes,
            grantTypes: ["authorization_code", "refresh_token"],
            responseTypes: ["code"],
            tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "none",
            requirePkce: input.requirePkce ?? true,
            accessTokenTtl: input.accessTokenTtl ?? 900,
            refreshTokenTtl: input.refreshTokenTtl ?? 86400,
            createdBy: userId,
          })
          .returning(),
      "createOAuthClient"
    )

    timer({ status: "success" })
    log.info("OAuth client created", { clientId })

    return createSuccess(
      {
        client: {
          id: created.id,
          clientId: created.clientId,
          clientName: created.clientName,
          redirectUris: created.redirectUris as string[],
          allowedScopes: created.allowedScopes as string[],
          grantTypes: created.grantTypes as string[],
          tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
          requirePkce: created.requirePkce,
          accessTokenTtl: created.accessTokenTtl,
          refreshTokenTtl: created.refreshTokenTtl,
          isActive: created.isActive,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
        clientSecret,
      },
      "OAuth client created"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to create OAuth client", {
      context: "createOAuthClient",
      requestId,
      operation: "createOAuthClient",
    })
  }
}

// ============================================
// Revoke (Deactivate) OAuth Client
// ============================================

export async function revokeOAuthClient(
  clientId: string
): Promise<ActionState<{ clientId: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("revokeOAuthClient")
  const log = createLogger({ requestId, action: "revokeOAuthClient" })

  try {
    await requireRole("administrator")

    log.info("Revoking OAuth client", { clientId })

    await executeQuery(
      (db) =>
        db
          .update(oauthClients)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(oauthClients.clientId, clientId)),
      "revokeOAuthClient"
    )

    timer({ status: "success" })
    log.info("OAuth client revoked", { clientId })

    return createSuccess({ clientId }, "OAuth client revoked")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to revoke OAuth client", {
      context: "revokeOAuthClient",
      requestId,
      operation: "revokeOAuthClient",
    })
  }
}
