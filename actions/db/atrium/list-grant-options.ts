"use server"

/**
 * Atrium list-grant-options server action
 *
 * Issue #1053 (Epic #1059, Atrium Phase 3). Supplies the visibility editor's
 * group-grant builder with the selectable options it can enumerate — the set of
 * role NAMES (a `role` grant matches `principal.roles`, which are role names; see
 * visibility-service §12.2) and the synced Google groups (#1205; a `group` grant
 * matches `principal.groups` by group email). Building / department / grade are
 * free-form `users` attributes with no reference table, so the editor accepts
 * those as free text; `user` grants take a numeric `users.id`.
 *
 * Gated by the Atrium authoring capability (not admin): any author building a
 * group grant needs the role + group lists, and the admin `getRoles` is admin-only.
 * Returning role names / group emails is not sensitive — they are the same names
 * surfaced on every role-gated UI and the group-directory admin page.
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
import {
  listActiveGroupsForPicker,
  type GroupPickerOption,
} from "@/lib/groups/queries";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export interface GrantOptions {
  /** Role names selectable for a `role` grant (matched against principal roles). */
  roles: string[];
  /**
   * Active synced Google groups selectable for a `group` grant (#1205). The stored
   * grant value is `email` (lowercased); `name` is display-only.
   */
  groups: GroupPickerOption[];
}

export async function listGrantOptionsAction(): Promise<ActionState<GrantOptions>> {
  const requestId = generateRequestId();
  const timer = startTimer("listGrantOptionsAction");
  const log = createLogger({ requestId, action: "listGrantOptionsAction" });

  try {
    log.info("Action started: list grant options");

    // Resolve the session ONCE and thread it to both the requester build and the
    // capability check (matching set-visibility / the other write-gated actions).
    // `getUserRequester` owns the authoritative null/sub check, so this action
    // automatically picks up any future session-contract changes (e.g. a
    // suspended-user gate) rather than rolling its own `!session?.sub`.
    const session = await getServerSession();
    await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    // Role names and active groups are independent lookups — run concurrently.
    const [roleRows, groupOptions] = await Promise.all([
      executeQuery(
        (db) => db.select({ name: roles.name }).from(roles).orderBy(asc(roles.name)),
        "atrium.listGrantOptions.roles"
      ),
      listActiveGroupsForPicker(),
    ]);

    timer({ status: "success" });
    log.info("Grant options loaded", {
      roleCount: roleRows.length,
      groupCount: groupOptions.length,
    });
    return createSuccess(
      { roles: roleRows.map((r) => r.name), groups: groupOptions },
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
