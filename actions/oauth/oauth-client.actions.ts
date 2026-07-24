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
import { hashArgon2 } from "@/lib/api-keys/argon2-loader"
import {
  isOAuthApplicationType,
  isPublicApplicationType,
  validateOAuthRedirectUris,
  type OAuthApplicationType,
} from "@/lib/oauth/redirect-uri-policy"
import type { ActionState } from "@/types"

// ============================================
// Types
// ============================================

export interface OAuthClientRow {
  id: number
  clientId: string
  clientName: string
  applicationType: OAuthApplicationType
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
  applicationType: OAuthApplicationType
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
            applicationType: oauthClients.applicationType,
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
    const clientName =
      typeof input.clientName === "string" ? input.clientName.trim() : ""

    log.info("Creating OAuth client", {
      name: sanitizeForLogging(clientName),
      applicationType: input.applicationType,
    })

    if (!isOAuthApplicationType(input.applicationType)) {
      throw ErrorFactories.invalidInput(
        "applicationType",
        input.applicationType,
        "Application type must be web, browser_extension, or native"
      )
    }
    if (clientName.length === 0 || clientName.length > 255) {
      throw ErrorFactories.invalidInput(
        "clientName",
        input.clientName,
        "Client name must be between 1 and 255 characters"
      )
    }
    if (input.requirePkce === false) {
      throw ErrorFactories.invalidInput(
        "requirePkce",
        input.requirePkce,
        "All authorization-code clients require S256 PKCE"
      )
    }
    if (
      input.tokenEndpointAuthMethod !== undefined &&
      input.tokenEndpointAuthMethod !== "none" &&
      input.tokenEndpointAuthMethod !== "client_secret_post"
    ) {
      throw ErrorFactories.invalidInput(
        "tokenEndpointAuthMethod",
        input.tokenEndpointAuthMethod,
        "Token endpoint authentication must be none or client_secret_post"
      )
    }
    if (
      isPublicApplicationType(input.applicationType) &&
      input.tokenEndpointAuthMethod !== undefined &&
      input.tokenEndpointAuthMethod !== "none"
    ) {
      throw ErrorFactories.invalidInput(
        "tokenEndpointAuthMethod",
        input.tokenEndpointAuthMethod,
        "Browser-extension and native clients are public, have no secret, and require S256 PKCE"
      )
    }
    if (
      !Array.isArray(input.redirectUris) ||
      !input.redirectUris.every((uri) => typeof uri === "string")
    ) {
      throw ErrorFactories.invalidInput(
        "redirectUris",
        input.redirectUris,
        "Redirect URIs must be a list of strings"
      )
    }
    if (
      !Array.isArray(input.allowedScopes) ||
      !input.allowedScopes.every((scope) => typeof scope === "string")
    ) {
      throw ErrorFactories.invalidInput(
        "allowedScopes",
        input.allowedScopes,
        "Allowed scopes must be a list of strings"
      )
    }

    const uriValidation = validateOAuthRedirectUris(
      input.applicationType,
      input.redirectUris
    )
    if (!uriValidation.valid) {
      log.warn("Invalid redirect URIs", { errors: uriValidation.errors })
      throw ErrorFactories.invalidInput(
        "redirectUris",
        input.redirectUris,
        uriValidation.errors.join("; ")
      )
    }

    const clientId = randomUUID()
    const publicApplication = isPublicApplicationType(input.applicationType)
    const authMethod = publicApplication
      ? "none"
      : (input.tokenEndpointAuthMethod ?? "none")
    const isConfidential = authMethod === "client_secret_post"

    let clientSecret: string | undefined
    let clientSecretHash: string | null = null

    if (isConfidential) {
      clientSecret = `cs-${randomBytes(32).toString("hex")}`
      clientSecretHash = await hashArgon2(clientSecret)
    }

    const [created] = await executeQuery(
      (db) =>
        db
          .insert(oauthClients)
          .values({
            clientId,
            clientName,
            applicationType: input.applicationType,
            clientSecretHash,
            redirectUris: uriValidation.normalizedUris,
            allowedScopes: input.allowedScopes,
            grantTypes: ["authorization_code", "refresh_token"],
            responseTypes: ["code"],
            tokenEndpointAuthMethod: authMethod,
            requirePkce: true,
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
          applicationType: created.applicationType,
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

    const revoked = await executeQuery(
      (db) =>
        db
          .update(oauthClients)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(oauthClients.clientId, clientId))
          .returning({ id: oauthClients.id }),
      "revokeOAuthClient"
    )

    if (revoked.length === 0) {
      // No row matched — a typo, stale UI, an already-deleted client, or a race.
      // Surface a failure instead of a false "revoked" success so an admin never
      // believes an OAuth client is disabled while it is still active (REV-COR-055).
      throw ErrorFactories.dbRecordNotFound("oauth_clients", clientId)
    }

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
