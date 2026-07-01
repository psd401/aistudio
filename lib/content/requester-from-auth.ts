/**
 * Atrium requester resolution for the agent surfaces (REST v1 + MCP)
 *
 * Issue #1055 (Epic #1059, Atrium Phase 5 — Agent access). The single place that
 * turns an authenticated API/MCP caller into a content-service `Requester` (§26).
 * Every content REST route and MCP tool builds its requester here so identity and
 * authorization are uniform across surfaces — mirroring how server actions use
 * `actions/db/atrium/requester.ts` for the logged-in-human path.
 *
 * Three caller shapes resolve to the three `Requester` kinds:
 *   - `delegated_for` claim present  -> `agent-delegated` (acts for that human,
 *     inherits exactly their roles/org; never admin — see `principalOf`).
 *   - `oauthClientId` ∈ active `agent_identities` -> `agent-autonomous`
 *     (role-driven visibility, scopes from the token, owns via the system user).
 *   - otherwise (sk- key / session / human OIDC token) -> `user`.
 *
 * Scope enforcement happens at the surface (`requireScope` / MCP `TOOL_SCOPE_MAP`)
 * BEFORE the service is called; this resolver only establishes WHO is calling.
 */

import { and, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentIdentities, roles, users } from "@/lib/db/schema";
import { getUserRoles } from "@/lib/db/user-roles";
import { createLogger } from "@/lib/logger";
import { ForbiddenError } from "./errors";
import type { Requester } from "./types";

const ADMIN_ROLE = "administrator";

/**
 * The minimal auth shape this resolver needs — satisfied by both
 * `ApiAuthContext` (REST) and `McpToolContext` (MCP, once it threads the OIDC
 * client id + delegation marker through).
 */
export interface RequesterAuthInput {
  userId: number;
  scopes: string[];
  oauthClientId?: string;
  delegatedForUserId?: number;
}

/** A user's roles + org attributes, shared by the user and delegated paths. */
async function loadUserContext(userId: number): Promise<{
  roles: string[];
  building: string | null;
  department: string | null;
  gradeLevels: string[] | null;
} | null> {
  // Defensive: a malformed token sub could yield a non-positive / NaN id; skip
  // the query and let the caller surface a clean auth error.
  if (!Number.isInteger(userId) || userId <= 0) return null;
  // The user-attributes SELECT and the roles lookup are independent, so run them
  // concurrently — this is on the hot path of every authenticated content REST/MCP
  // call. A not-found user makes the roles query wasted work, but that path is
  // rare (a deleted/invalid token sub) and the common found-user path saves a
  // round trip.
  const [rows, roleNames] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            building: users.building,
            department: users.department,
            gradeLevels: users.gradeLevels,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
      "atrium.requesterFromAuth.loadUser"
    ),
    getUserRoles(userId),
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    roles: roleNames,
    building: row.building,
    department: row.department,
    gradeLevels: row.gradeLevels,
  };
}

/** Look up the active autonomous agent identity bound to an OIDC client. */
async function findAgentIdentity(oauthClientId: string): Promise<{
  id: string;
  name: string;
  roleId: number | null;
  roleName: string | null;
} | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: agentIdentities.id,
          name: agentIdentities.name,
          roleId: agentIdentities.roleId,
          roleName: roles.name,
        })
        .from(agentIdentities)
        .leftJoin(roles, eq(agentIdentities.roleId, roles.id))
        .where(
          and(
            eq(agentIdentities.oauthClientId, oauthClientId),
            eq(agentIdentities.isActive, true)
          )
        )
        .limit(1),
    "atrium.requesterFromAuth.findAgent"
  );
  return rows[0] ?? null;
}

/**
 * Build the `agent-delegated` requester. Exposed (and unit-tested) on its own so
 * the grant-inheritance invariant is explicit: it carries the human's roles/org
 * but `principalOf` forces `isAdmin:false`, so a delegated agent can NEVER exceed
 * the human's grants even when the human is an administrator.
 */
export function buildDelegatedRequester(input: {
  actingForUserId: number;
  roles: string[];
  building: string | null;
  department: string | null;
  gradeLevels: string[] | null;
  scopes: string[];
  agentLabel: string;
}): Requester {
  return {
    kind: "agent-delegated",
    actingForUserId: input.actingForUserId,
    roles: input.roles,
    building: input.building,
    department: input.department,
    gradeLevels: input.gradeLevels,
    scopes: input.scopes,
    agentLabel: input.agentLabel,
  };
}

/**
 * Resolve an authenticated API/MCP caller into a content `Requester`. Throws when
 * a referenced user row is missing (a token for a deleted user must not silently
 * become a guest with surprising access).
 */
export async function requesterFromApiAuth(
  auth: RequesterAuthInput
): Promise<Requester> {
  const log = createLogger({ action: "atrium.requesterFromAuth" });

  // 1. Delegated: an explicit `delegated_for` human wins. The agent inherits that
  //    human's roles/org; scopes come from the token (gate `content:update` etc.).
  if (auth.delegatedForUserId != null) {
    const ctx = await loadUserContext(auth.delegatedForUserId);
    if (ctx) {
      log.debug("Resolved agent-delegated requester", {
        actingForUserId: auth.delegatedForUserId,
        agentLabel: auth.oauthClientId,
      });
      return buildDelegatedRequester({
        actingForUserId: auth.delegatedForUserId,
        roles: ctx.roles,
        building: ctx.building,
        department: ctx.department,
        gradeLevels: ctx.gradeLevels,
        scopes: auth.scopes,
        agentLabel: auth.oauthClientId ?? "delegated-agent",
      });
    }
    // A stale/invalid `delegated_for` claim (e.g. the delegating human's
    // account was deleted) on a token that ALSO carries an `oauthClientId` is
    // not necessarily a dead token — it may still be a legitimate registered
    // agent. Fall through to step 2 (autonomous) rather than hard-failing;
    // only reject outright when there is no other identity to try.
    if (!auth.oauthClientId) {
      // A token for a deleted/invalid human is an auth failure (403), not a 500.
      throw new ForbiddenError("Delegated-for user not found", {
        delegatedForUserId: auth.delegatedForUserId,
      });
    }
    log.warn(
      "Delegated-for user not found; falling back to autonomous resolution",
      {
        delegatedForUserId: auth.delegatedForUserId,
        oauthClientId: auth.oauthClientId,
      }
    );
  }

  // 2. Autonomous: the OIDC client is a registered service/skill identity.
  //    `oauthClientId` is only ever populated for a machine (client-credentials)
  //    JWT (see auth-middleware.ts) — a real human never carries one. If that
  //    client has no ACTIVE agent identity (deactivated, or never registered),
  //    fail closed here rather than falling through to step 3: step 3 resolves
  //    `auth.userId`, which for a client-credentials token is always
  //    `ATRIUM_SYSTEM_USER_ID` — silently re-resolving a revoked/unknown agent
  //    as the system account would undo a deliberate deactivation instead of
  //    blocking it.
  if (auth.oauthClientId) {
    const identity = await findAgentIdentity(auth.oauthClientId);
    if (!identity) {
      throw new ForbiddenError("No active agent identity for this client", {
        oauthClientId: auth.oauthClientId,
      });
    }
    log.debug("Resolved agent-autonomous requester", {
      agentId: identity.id,
      agentLabel: identity.name,
    });
    return {
      kind: "agent-autonomous",
      agentId: identity.id,
      roleId: identity.roleId,
      roles: identity.roleName ? [identity.roleName] : [],
      scopes: auth.scopes,
      agentLabel: identity.name,
    };
  }

  // 3. User: sk- key, session, or a human OIDC token acting as themselves.
  const ctx = await loadUserContext(auth.userId);
  if (!ctx) {
    // A token for a deleted/invalid user is an auth failure (403), not a 500.
    throw new ForbiddenError("User not found", { userId: auth.userId });
  }
  log.debug("Resolved user requester", { userId: auth.userId });
  return {
    kind: "user",
    userId: auth.userId,
    roles: ctx.roles,
    building: ctx.building,
    department: ctx.department,
    gradeLevels: ctx.gradeLevels,
    isAdmin: ctx.roles.includes(ADMIN_ROLE),
  };
}
