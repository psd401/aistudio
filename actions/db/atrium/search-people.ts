"use server"

/**
 * Atrium people-search server action (#1336 C5)
 *
 * Backs the visibility editor's PEOPLE PICKER. A `user` visibility grant stores
 * a numeric `users.id`, and until now the editor made the author type that id in
 * by hand — an unusable control (nobody knows anyone's row id), which is a large
 * part of why per-person sharing was effectively unreachable.
 *
 * Gated by the same `atrium-content` authoring capability as
 * `listGrantOptionsAction`, for the same reason: any author building a grant
 * needs it, and this is not the admin user-management surface.
 *
 * The query itself lives in `lib/content/people-search` (#1860) so this action
 * and the agent broker's `GET /_people` share one projection, one result cap, and
 * one minimum query length. This file is the SESSION door onto it: auth, the
 * capability gate, logging, and the `ActionState` envelope.
 */

import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { searchPeople, type PersonOption } from "@/lib/content/people-search";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export type { PersonOption };

export async function searchPeopleAction(
  query: string
): Promise<ActionState<PersonOption[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("searchPeopleAction");
  const log = createLogger({ requestId, action: "searchPeopleAction" });

  try {
    log.info("Action started: search people", {
      query: sanitizeForLogging(query),
    });

    const session = await getServerSession();
    // Requester first so an unauthenticated caller gets a 401, not a 403 —
    // `hasCapabilityAccess` returns false (not throws) on a missing session.
    await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    // The picker shows a bounded type-ahead list and has no "more results"
    // affordance, so the `truncated` half of the result is deliberately dropped
    // here; the agent surface, which has no scrollback, reports it.
    const { people } = await searchPeople(query);

    timer({ status: "success" });
    log.info("People found", { count: people.length });
    return createSuccess(people, "People found");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to search people", {
      context: "searchPeopleAction",
      requestId,
      operation: "searchPeopleAction",
    });
  }
}
