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
import { z } from "zod"
import {
  isPublicApplicationType,
  validateOAuthRedirectUris,
  OAUTH_APPLICATION_TYPES,
  type OAuthApplicationType,
} from "@/lib/oauth/redirect-uri-policy"
import { withPublicClientRequiredScopes } from "@/lib/oauth/oauth-scopes"
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
  isFirstParty: boolean
  createdAt: Date
  updatedAt: Date
}

const oauthClientBaseFields = {
  clientName: z.string().trim().min(1).max(255),
  redirectUris: z.array(z.string()),
  allowedScopes: z.array(z.string()),
  requirePkce: z.literal(true).optional(),
  accessTokenTtl: z.number().int().positive().optional(),
  refreshTokenTtl: z.number().int().positive().optional(),
}

/**
 * Runtime boundary for the server action. Public application profiles only
 * admit `none`, while confidential authentication is available exclusively to
 * the web profile. PKCE is either omitted or explicitly true for every profile.
 */
const createOAuthClientInputSchema = z.discriminatedUnion("applicationType", [
  z.object({
    ...oauthClientBaseFields,
    applicationType: z.literal(OAUTH_APPLICATION_TYPES[0]),
    tokenEndpointAuthMethod: z
      .enum(["none", "client_secret_post"])
      .optional(),
  }),
  z.object({
    ...oauthClientBaseFields,
    applicationType: z.literal(OAUTH_APPLICATION_TYPES[1]),
    tokenEndpointAuthMethod: z.literal("none").optional(),
  }),
  z.object({
    ...oauthClientBaseFields,
    applicationType: z.literal(OAUTH_APPLICATION_TYPES[2]),
    tokenEndpointAuthMethod: z.literal("none").optional(),
  }),
])

/**
 * Untrusted server-action boundary. Keep this wider than the parsed profile
 * union so callers can submit form state and the runtime schema—not TypeScript—
 * remains the security authority for rejecting invalid combinations.
 */
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
            isFirstParty: oauthClients.isFirstParty,
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
    const validated = createOAuthClientInputSchema.parse(input)
    const clientName = validated.clientName

    log.info("Creating OAuth client", {
      name: sanitizeForLogging(clientName),
      applicationType: validated.applicationType,
    })

    const uriValidation = validateOAuthRedirectUris(
      validated.applicationType,
      validated.redirectUris
    )
    if (!uriValidation.valid) {
      log.warn("Invalid redirect URIs", { errors: uriValidation.errors })
      throw ErrorFactories.invalidInput(
        "redirectUris",
        validated.redirectUris,
        uriValidation.errors.join("; ")
      )
    }

    const clientId = randomUUID()
    const publicApplication = isPublicApplicationType(validated.applicationType)
    const authMethod = publicApplication
      ? "none"
      : (validated.tokenEndpointAuthMethod ?? "none")
    const isConfidential = authMethod === "client_secret_post"
    const allowedScopes =
      authMethod === "none"
        ? withPublicClientRequiredScopes(validated.allowedScopes)
        : [...new Set(validated.allowedScopes)]

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
            applicationType: validated.applicationType,
            clientSecretHash,
            redirectUris: uriValidation.normalizedUris,
            allowedScopes,
            grantTypes: ["authorization_code", "refresh_token"],
            responseTypes: ["code"],
            tokenEndpointAuthMethod: authMethod,
            requirePkce: true,
            accessTokenTtl: validated.accessTokenTtl ?? 900,
            refreshTokenTtl: validated.refreshTokenTtl ?? 86400,
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
          isFirstParty: created.isFirstParty,
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

const updateOAuthClientRedirectUrisInputSchema = z.object({
  clientId: z.string().trim().min(1).max(255),
  redirectUris: z.array(z.string()).min(1),
  // Reactivating is part of the same edit: a client is often revoked precisely
  // because its redirect list was wrong and revoke was the only control that
  // existed. Omitted leaves the current state alone.
  isActive: z.boolean().optional(),
})

export type UpdateOAuthClientRedirectUrisInput = z.infer<
  typeof updateOAuthClientRedirectUrisInputSchema
>

/**
 * Update a registered client's redirect URIs (and optionally reactivate it).
 *
 * Deliberately narrow. Before this existed the admin surface was
 * create/list/revoke only, so a client with one bad redirect URI could not be
 * corrected at all — on 2026-08-10 that took out agent-connect for every user,
 * and revoking was the only button available (see migration 176). Redirect
 * URIs are the field that actually rots: hosts move, dev callbacks get left
 * behind, extension ids change.
 *
 * NOT editable here, on purpose. `applicationType`, `tokenEndpointAuthMethod`,
 * `requirePkce`, the secret and the scopes all define the client's security
 * profile, and changing them on a live registration silently alters what an
 * already-issued grant means. Those still require creating a new client.
 *
 * The new URIs are validated against the STORED application type, never a
 * caller-supplied one, so a native client cannot be relaxed into web rules by
 * passing a different type alongside the URIs.
 */
export async function updateOAuthClientRedirectUris(
  input: UpdateOAuthClientRedirectUrisInput
): Promise<ActionState<{ clientId: string; redirectUris: string[] }>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateOAuthClientRedirectUris")
  const log = createLogger({
    requestId,
    action: "updateOAuthClientRedirectUris",
  })

  try {
    await requireRole("administrator")

    const validated = updateOAuthClientRedirectUrisInputSchema.parse(input)

    const [existing] = await executeQuery(
      (db) =>
        db
          .select({
            applicationType: oauthClients.applicationType,
          })
          .from(oauthClients)
          .where(eq(oauthClients.clientId, validated.clientId))
          .limit(1),
      "updateOAuthClientRedirectUris.load"
    )

    if (!existing) {
      throw ErrorFactories.dbRecordNotFound("oauth_clients", validated.clientId)
    }

    const applicationType = existing.applicationType as OAuthApplicationType
    const uriValidation = validateOAuthRedirectUris(
      applicationType,
      validated.redirectUris
    )
    if (!uriValidation.valid) {
      // Surfaced to the admin editing the form, who typed these and needs the
      // full string to correct them. The adapter redacts before LOGGING; this
      // path returns them to the authenticated administrator instead.
      log.warn("Rejected redirect URI update", {
        clientId: validated.clientId,
        errorCount: uriValidation.errors.length,
      })
      throw ErrorFactories.invalidInput(
        "redirectUris",
        validated.redirectUris,
        uriValidation.errors.join("; ")
      )
    }

    const updated = await executeQuery(
      (db) =>
        db
          .update(oauthClients)
          .set({
            redirectUris: uriValidation.normalizedUris,
            ...(validated.isActive === undefined
              ? {}
              : { isActive: validated.isActive }),
            updatedAt: new Date(),
          })
          .where(eq(oauthClients.clientId, validated.clientId))
          .returning({ id: oauthClients.id }),
      "updateOAuthClientRedirectUris"
    )

    if (updated.length === 0) {
      // Same reasoning as revokeOAuthClient: never report a successful edit for
      // a row that did not change, or an admin believes a broken client is fixed.
      throw ErrorFactories.dbRecordNotFound("oauth_clients", validated.clientId)
    }

    timer({ status: "success" })
    log.info("OAuth client redirect URIs updated", {
      clientId: validated.clientId,
      uriCount: uriValidation.normalizedUris.length,
      isActive: validated.isActive,
    })

    return createSuccess(
      {
        clientId: validated.clientId,
        redirectUris: uriValidation.normalizedUris,
      },
      "OAuth client updated"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update OAuth client", {
      context: "updateOAuthClientRedirectUris",
      requestId,
      operation: "updateOAuthClientRedirectUris",
    })
  }
}
