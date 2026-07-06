/**
 * Atrium delegated-agent token minting (§26.1, Epic #1059, Phase 5)
 * POST /api/v1/agents/delegated-token
 *
 * The MINTING half of delegated agents. An authorized autonomous agent, holding
 * `content:delegate`, exchanges its own client-credentials JWT for a SHORT-LIVED
 * token that acts on behalf of a named human, bounded to scopes that human could
 * exercise. The content surface already CONSUMES the resulting `delegated_for`
 * claim (auth-middleware → requesterFromApiAuth → agent-delegated requester,
 * isAdmin forced false); this route is what finally makes that path reachable.
 *
 * Stateless: the token is signed by the existing OIDC signer (verifies through the
 * same JWKS, no new key wiring) and is NOT persisted — the short TTL
 * (`DELEGATED_TOKEN_TTL_SECONDS`) is the mitigation for non-revocability.
 *
 * Authorization to mint (all required):
 *  - `content:delegate` scope (agent-held; requireScope),
 *  - a `jwt` auth type with an `oauthClientId` that maps to an ACTIVE
 *    `agent_identities` row (a human OIDC token or sk-key can hold the scope via a
 *    role but is not a registered agent, so it is rejected here),
 *  - the caller's own token is NOT already delegated (no re-delegation).
 *
 * The minted scope = requested ∩ agent's content scopes ∩ the user's role-derived
 * content scopes (`intersectDelegatedScopes`), so a delegated token can never exceed
 * what the human could do and never carries the `content:delegate` authority itself.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { withApiAuth, requireScope, createErrorResponse, createApiResponse } from "@/lib/api";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentIdentities } from "@/lib/db/schema";
import { getUserRoles } from "@/lib/db/user-roles";
import { getScopesForRoles } from "@/lib/api-keys/scopes";
import { systemUserIdOrNull } from "@/lib/content/helpers";
import { getIssuerUrl } from "@/lib/oauth/issuer-config";
import { getJwtSigner } from "@/lib/oauth/jwt-signer";
import {
  DELEGATED_TOKEN_TTL_SECONDS,
  intersectDelegatedScopes,
  buildDelegatedTokenClaims,
} from "@/lib/oauth/delegated-token";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** The human user id the agent will act on behalf of. */
  delegated_for: z.number().int().positive(),
  /**
   * Optional space-delimited scope narrowing. Omitted → the full grantable
   * intersection (agent ∩ user content scopes). Never widens beyond that.
   */
  scope: z.string().max(500).optional(),
});

/** The active agent identity behind an OIDC client id, or null. */
async function activeAgentByClientId(
  oauthClientId: string
): Promise<{ scopes: string[]; name: string } | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ scopes: agentIdentities.scopes, name: agentIdentities.name })
        .from(agentIdentities)
        .where(
          and(
            eq(agentIdentities.oauthClientId, oauthClientId),
            eq(agentIdentities.isActive, true)
          )
        )
        .limit(1),
    "atrium.delegatedToken.findAgent"
  );
  return rows[0] ?? null;
}

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.agents.delegated-token" });

  // 1. Authority: the caller must hold the agent-held `content:delegate` scope.
  const scopeError = requireScope(auth, "content:delegate", requestId);
  if (scopeError) return scopeError;

  // 2. The caller must be an OIDC agent token, not a session/sk-key, and must not
  //    itself be a delegated token (no re-delegation — a delegated token cannot mint).
  if (auth.authType !== "jwt" || !auth.oauthClientId) {
    return createErrorResponse(
      requestId,
      403,
      "FORBIDDEN",
      "Delegated tokens can only be minted by an OIDC agent identity"
    );
  }
  if (auth.delegatedForUserId != null) {
    return createErrorResponse(
      requestId,
      403,
      "FORBIDDEN",
      "A delegated token cannot mint further delegated tokens"
    );
  }

  // 3. The OIDC client must map to an ACTIVE registered agent identity.
  const agent = await activeAgentByClientId(auth.oauthClientId);
  if (!agent) {
    return createErrorResponse(
      requestId,
      403,
      "FORBIDDEN",
      "The requesting OIDC client is not an active agent identity"
    );
  }

  // 4. Body.
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Invalid request body",
      err instanceof z.ZodError ? err.issues : undefined
    );
  }

  // 5. System user id (the minted `sub`) must be configured.
  const systemUserId = systemUserIdOrNull();
  if (systemUserId == null) {
    log.error("ATRIUM_SYSTEM_USER_ID not configured; cannot mint delegated token");
    return createErrorResponse(
      requestId,
      500,
      "CONFIGURATION_ERROR",
      "Delegated token minting is not configured"
    );
  }

  // 6. Load the acting-for user's role-derived content scopes. A NON-EXISTENT user
  //    has no roles, so `getUserRoles` returns [] → no grantable scopes → the same
  //    403 as a role-less user below. Collapsing "unknown user" and "no grantable
  //    scope" into one response deliberately avoids a user-id ENUMERATION side
  //    channel (a distinct 404 would let a delegation-capable agent probe which
  //    user ids exist).
  const userRoleScopes = getScopesForRoles(await getUserRoles(body.delegated_for));

  // 7. Intersect: requested ∩ agent content scopes ∩ user content scopes.
  const requested = body.scope ? body.scope.split(" ").filter(Boolean) : null;
  const scopes = intersectDelegatedScopes(requested, agent.scopes, userRoleScopes);
  if (scopes.length === 0) {
    return createErrorResponse(
      requestId,
      403,
      "INSUFFICIENT_SCOPE",
      "No content scopes are grantable for this agent + user combination"
    );
  }

  // 8. Build + sign. Date/randomUUID are resolved HERE (the claim builder is pure).
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = buildDelegatedTokenClaims({
    systemUserId: String(systemUserId),
    delegatedForUserId: body.delegated_for,
    agentClientId: auth.oauthClientId,
    scopes,
    issuer: getIssuerUrl(),
    nowSeconds,
    jti: crypto.randomUUID(),
  });
  const signer = await getJwtSigner();
  const accessToken = await signer.signJwt(claims);

  // Audit via the logger — NEVER log the token itself.
  log.info("Minted delegated content token", {
    agent: agent.name,
    agentClientId: auth.oauthClientId,
    delegatedForUserId: body.delegated_for,
    scopes,
    ttlSeconds: DELEGATED_TOKEN_TTL_SECONDS,
  });

  return createApiResponse(
    {
      data: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: DELEGATED_TOKEN_TTL_SECONDS,
        scope: scopes.join(" "),
        delegated_for: body.delegated_for,
      },
      meta: { requestId },
    },
    requestId
  );
});
