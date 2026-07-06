/**
 * Delegated-agent token minting — pure claim + scope logic (Atrium §26.1, #1059)
 *
 * An authorized autonomous agent exchanges its own client-credentials JWT for a
 * SHORT-LIVED delegated token that acts on behalf of a specific human, bounded to
 * scopes that human could exercise. The Atrium content surface already CONSUMES a
 * `delegated_for` claim (`auth-middleware.ts` → `requesterFromApiAuth` →
 * `buildDelegatedRequester`, with `principalOf` forcing isAdmin:false); this module
 * is the MINTING half — the last piece that makes `agent-delegated` reachable.
 *
 * Stateless by design: the token is signed by the existing OIDC signer (so it
 * verifies through the same JWKS with no new key wiring) and is NOT persisted. The
 * short TTL is the mitigation for non-revocability — keep it minutes-scale.
 *
 * This module is intentionally DB-free and side-effect-free so the scope-bounding
 * and claim shape are unit-testable without a database or a signer. The route
 * (`app/api/v1/agents/delegated-token/route.ts`) supplies the DB-derived inputs,
 * the clock, and the jti, then signs.
 */

/** Delegated token lifetime. Minutes-scale: the token is non-revocable, so short. */
export const DELEGATED_TOKEN_TTL_SECONDS = 300;

/** Prefix identifying Atrium content scopes. */
const CONTENT_SCOPE_PREFIX = "content:";

/**
 * The minting AUTHORITY scope (held by a delegation-capable agent), NOT a content
 * DATA operation. It is deliberately excluded from every minted delegated token so
 * a delegated credential can never re-mint (defense in depth on top of the route's
 * "a delegated token cannot itself delegate" check).
 */
export const DELEGATION_AUTHORITY_SCOPE = "content:delegate";

/** A content DATA scope that may appear in a delegated token (excludes the authority scope). */
function isDelegableContentScope(scope: string): boolean {
  return (
    scope.startsWith(CONTENT_SCOPE_PREFIX) && scope !== DELEGATION_AUTHORITY_SCOPE
  );
}

/**
 * Compute the delegated token's scopes:
 *   requested ∩ (agent's grantable content scopes) ∩ (user's role-derived content scopes)
 *
 * Every set is first filtered to delegable CONTENT scopes, so a delegated token is a
 * pure content credential — it can never carry `chat:*` / `assistants:*` (which would
 * otherwise execute as the token's `sub`, the low-privilege system user, on other
 * surfaces) nor the `content:delegate` authority scope.
 *
 * `requested === null` means "everything grantable" (the caller omitted a `scope`
 * param) and yields `agent ∩ user`. A non-null `requested` narrows further; an
 * unknown/non-content requested scope simply drops out (intersection). The result is
 * sorted for a deterministic scope string.
 *
 * Because the result is bounded by BOTH the agent's own scopes AND the acting-for
 * user's role-derived scopes, a delegated token can never exceed what that human
 * could do (e.g. a staff user's delegation never contains `content:publish_public`),
 * and a compromised agent gains nothing beyond the intersection.
 */
export function intersectDelegatedScopes(
  requested: string[] | null,
  agentScopes: string[],
  userRoleScopes: string[]
): string[] {
  const agent = new Set(agentScopes.filter(isDelegableContentScope));
  const user = new Set(userRoleScopes.filter(isDelegableContentScope));
  const grantable = [...agent].filter((scope) => user.has(scope));
  if (requested === null) return grantable.sort();
  const req = new Set(requested);
  return grantable.filter((scope) => req.has(scope)).sort();
}

/** Inputs for a delegated token's claim set (all DB/clock values resolved by the route). */
export interface DelegatedTokenClaimsInput {
  /** `sub` — the §26.5 system user id (string), NOT the human. See module + route notes. */
  systemUserId: string;
  /** The human the token acts for → the numeric `delegated_for` claim. */
  delegatedForUserId: number;
  /** The requesting agent's OIDC client id → `client_id`/`azp` (agent attribution). */
  agentClientId: string;
  /** The already-intersected delegated scopes. */
  scopes: string[];
  /** Token issuer + audience (`getIssuerUrl()`). */
  issuer: string;
  /** `Math.floor(Date.now() / 1000)` from the route. */
  nowSeconds: number;
  /** A unique token id (`crypto.randomUUID()` from the route). */
  jti: string;
}

/**
 * Build the delegated token claim set.
 *
 * `sub` is the SYSTEM user, not the human: on any surface that does NOT honor
 * `delegated_for` (e.g. `/api/v1/chat`), the token resolves to the low-privilege
 * system account rather than the full human — blast-radius containment. Only the
 * content resolver reads `delegated_for` (first) to grant delegated authority.
 *
 * `delegated_for` is emitted NUMERIC — it is the SOLE delegation trigger the
 * consumer honors (`parseDelegatedForClaim` in `auth-middleware.ts`). `act.sub`
 * carries the agent's client id for RFC-8693-style AUDIT richness only; the consumer
 * no longer falls back to it, so it is informational. It is kept non-numeric (a
 * client id) as defensive hygiene regardless.
 */
export function buildDelegatedTokenClaims(
  input: DelegatedTokenClaimsInput
): Record<string, unknown> {
  return {
    iss: input.issuer,
    aud: input.issuer,
    sub: input.systemUserId,
    client_id: input.agentClientId,
    azp: input.agentClientId,
    delegated_for: input.delegatedForUserId,
    act: { sub: input.agentClientId },
    scope: input.scopes.join(" "),
    iat: input.nowSeconds,
    exp: input.nowSeconds + DELEGATED_TOKEN_TTL_SECONDS,
    jti: input.jti,
  };
}
