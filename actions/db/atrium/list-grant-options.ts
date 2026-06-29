"use server"

/**
 * Atrium list-grant-options server action
 *
 * Issue #1053 (Epic #1059, Atrium Phase 3). Supplies the visibility editor's
 * group-grant builder with the selectable options it can enumerate — currently
 * the set of role NAMES (a `role` grant matches `principal.roles`, which are role
 * names; see visibility-service §12.2). Building / department / grade are
 * free-form `users` attributes with no reference table, so the editor accepts
 * those as free text; `user` grants take a numeric `users.id`.
 *
 * Gated by the Atrium authoring capability (not admin): any author building a
 * group grant needs the role list, and the admin `getRoles` is admin-only.
 * Returning role names is not sensitive — they are the same names surfaced on
 * every role-gated UI.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { executeQuery } from "@/lib/db/drizzle-client";
import { roles } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";

export interface GrantOptions {
  /** Role names selectable for a `role` grant (matched against principal roles). */
  roles: string[];
}

export async function listGrantOptionsAction(): Promise<ActionState<GrantOptions>> {
  const requestId = generateRequestId();
  const timer = startTimer("listGrantOptionsAction");
  const log = createLogger({ requestId, action: "listGrantOptionsAction" });

  try {
    log.info("Action started: list grant options");

    const session = await getServerSession();
    if (!session?.sub) {
      throw ErrorFactories.authNoSession();
    }
    if (!(await hasCapabilityAccess("atrium-content", session.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    const roleRows = await executeQuery(
      (db) => db.select({ name: roles.name }).from(roles).orderBy(asc(roles.name)),
      "atrium.listGrantOptions.roles"
    );

    timer({ status: "success" });
    log.info("Grant options loaded", { roleCount: roleRows.length });
    return createSuccess(
      { roles: roleRows.map((r) => r.name) },
      "Grant options loaded"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load grant options", {
      context: "listGrantOptionsAction",
      requestId,
      operation: "listGrantOptionsAction",
    });
  }
}
