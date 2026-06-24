"use server"

/**
 * Atrium server-action requester resolution
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Builds the content service's
 * `Requester` (kind "user") from the current Cognito session: resolves the
 * integer `users.id`, the user's roles, org attributes (building / department /
 * grade levels) used by group-visibility, and admin status.
 *
 * Server actions are the logged-in-human surface, so this always produces a
 * `user` Requester. Delegated/autonomous agent requesters are constructed by the
 * REST/MCP surfaces in Phase 5.
 */

import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRoles } from "@/lib/db/user-roles";
import { ErrorFactories } from "@/lib/error-utils";
import { createLogger, generateRequestId } from "@/lib/logger";
import type { Requester } from "@/lib/content";

const ADMIN_ROLE = "administrator";

/**
 * A guest (unauthenticated) `user` Requester: no userId, no roles. `canView`
 * admits only `public` content for this principal (visibility-service.ts §11.2),
 * and the write-path helpers (`ownerFor`) reject a null userId, so a guest can
 * read public content but never author.
 */
const GUEST_REQUESTER: Requester = {
  kind: "user",
  userId: null,
  roles: [],
  building: null,
  department: null,
  gradeLevels: null,
  isAdmin: false,
};

/**
 * Resolve the current session into an authenticated `user` Requester, or `null`
 * when there is no session / no matching user row. Shared by
 * `getUserRequester` (which throws on null) and `getOptionalRequester` (which
 * falls back to a guest).
 */
async function resolveAuthenticatedRequester(
  requestId?: string
): Promise<Requester | null> {
  // Correlate with the calling action's request id when provided; fall back to
  // a fresh id only when called outside an action context.
  const log = createLogger({
    requestId: requestId ?? generateRequestId(),
    action: "resolveAtriumRequester",
  });

  const session = await getServerSession();
  if (!session?.sub) {
    log.debug("No active session resolving Atrium requester");
    return null;
  }

  const userRows = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          building: users.building,
          department: users.department,
          gradeLevels: users.gradeLevels,
        })
        .from(users)
        .where(eq(users.cognitoSub, session.sub))
        .limit(1),
    "atrium.resolveAtriumRequester"
  );

  const user = userRows[0];
  if (!user) {
    log.warn("Session has no matching user row", { cognitoSub: session.sub });
    return null;
  }

  const roles = await getUserRoles(user.id);
  log.debug("Resolved Atrium requester", { userId: user.id, roleCount: roles.length });

  return {
    kind: "user",
    userId: user.id,
    roles,
    building: user.building,
    department: user.department,
    gradeLevels: user.gradeLevels,
    isAdmin: roles.includes(ADMIN_ROLE),
  };
}

/**
 * Resolve the current session into a `user` Requester. Throws
 * `ErrorFactories.authNoSession()` when there is no session or no matching user
 * row (so server actions surface a 401-style error via handleError). Use for
 * write actions, where a session is mandatory.
 */
export async function getUserRequester(requestId?: string): Promise<Requester> {
  const requester = await resolveAuthenticatedRequester(requestId);
  if (!requester) {
    throw ErrorFactories.authNoSession();
  }
  return requester;
}

/**
 * Resolve the current session into a `user` Requester, falling back to a guest
 * Requester (no userId, no roles) when there is no session. Use for read
 * actions so unauthenticated callers can still read `public` content — read
 * access is bounded entirely by `canView`, not by the presence of a session.
 */
export async function getOptionalRequester(
  requestId?: string
): Promise<Requester> {
  const requester = await resolveAuthenticatedRequester(requestId);
  return requester ?? GUEST_REQUESTER;
}
