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
 * Resolve the current session into a `user` Requester. Throws
 * `ErrorFactories.authNoSession()` when there is no session or no matching user
 * row (so server actions surface a 401-style error via handleError).
 */
export async function getUserRequester(): Promise<Requester> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, action: "getUserRequester" });

  const session = await getServerSession();
  if (!session?.sub) {
    log.warn("No active session resolving Atrium requester");
    throw ErrorFactories.authNoSession();
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
    "atrium.getUserRequester"
  );

  const user = userRows[0];
  if (!user) {
    log.warn("Session has no matching user row", { cognitoSub: session.sub });
    throw ErrorFactories.authNoSession();
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
