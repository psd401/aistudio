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
 * needs it, and this is not the admin user-management surface. The projection is
 * deliberately narrow — id, display name, email — the exact fields the picker
 * renders, and no more. Results are capped and only returned for a query of at
 * least MIN_QUERY_LENGTH characters, so this cannot be walked as a full
 * directory dump.
 */

import { asc, ilike, or, sql } from "drizzle-orm";
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { executeQuery } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

/**
 * Shortest accepted query. Below this the action returns an empty list rather
 * than matching a large slice of the directory on one or two characters.
 */
const MIN_QUERY_LENGTH = 2;

/** Upper bound on the bound search parameter. */
const MAX_QUERY_LENGTH = 100;

/** Max rows returned per search. The picker is a type-ahead, not a browser. */
const RESULT_LIMIT = 20;

/**
 * Escape LIKE/ILIKE metacharacters so a query like `50%` matches literally
 * instead of acting as a wildcard. Mirrors `visibility-service`'s helper; the
 * pattern is still a bound parameter, so this is pattern hygiene, not injection
 * protection.
 */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface PersonOption {
  /** The `users.id` stored as the grant value. */
  id: number;
  /** Full name when set, else the email local part. Display only. */
  name: string;
  email: string;
}

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

    const trimmed = (query ?? "").trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      timer({ status: "success" });
      return createSuccess([], "People found");
    }

    const pattern = `%${escapeLikePattern(trimmed.slice(0, MAX_QUERY_LENGTH))}%`;
    const displayName = sql<string>`coalesce(nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), split_part(${users.email}, '@', 1))`;

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: users.id,
            name: displayName,
            email: users.email,
          })
          .from(users)
          .where(
            or(
              ilike(users.email, pattern),
              ilike(users.firstName, pattern),
              ilike(users.lastName, pattern),
              // Match against the CONCATENATED name too, so "Jane Doe" finds a
              // row whose first and last names each match only half the query.
              sql`concat_ws(' ', ${users.firstName}, ${users.lastName}) ILIKE ${pattern}`
            )
          )
          .orderBy(asc(users.email))
          .limit(RESULT_LIMIT),
      "atrium.searchPeople"
    );

    timer({ status: "success" });
    log.info("People found", { count: rows.length });
    return createSuccess(rows as PersonOption[], "People found");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to search people", {
      context: "searchPeopleAction",
      requestId,
      operation: "searchPeopleAction",
    });
  }
}
