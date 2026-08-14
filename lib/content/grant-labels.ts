/**
 * Human-readable labels for visibility grants.
 *
 * A `user` grant stores the numeric `users.id` as text, because that is the
 * only stable identifier — names and emails change. The share dialog rendered
 * that identifier verbatim, so the grant list read "user 42": correct, and
 * useless. Nobody can confirm they shared a document with the right person by
 * reading a primary key.
 *
 * Every other grant kind already stores something a person can read (a role
 * NAME, a building/department/grade value, a Google group email), so only
 * `user` needs resolving.
 *
 * ## Exposure
 *
 * Only ever called for a caller who has already passed the editor gate in
 * `getVisibilityAction` — grants are not returned to non-editors at all, so
 * this adds no new disclosure. The name shown is the same one
 * `searchPeopleAction` already returns to the same editors when they pick a
 * person, so the roster reads the way it was written.
 */

import { inArray } from "drizzle-orm";
import { executeQuery, type DrizzleDB } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";
import type { VisibilityGrant } from "./types";

/**
 * The key a label is filed under: `${kind}:${value}`.
 *
 * NOT exported. The client components that also build this key
 * (`VisibilityChip`'s `addGrant` and `grantDisplay`) cannot import from this
 * module — it pulls in Drizzle and the DB client — so exporting it would
 * advertise a shared contract that only one side can actually use. The format
 * is two segments and stable; both sides document it.
 */
function grantLabelKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

/**
 * Display labels for the `user` grants in `grants`, keyed by
 * `${kind}:${value}`. Kinds that are already readable are absent from the map
 * and the caller falls back to the raw value.
 *
 * A grant pointing at a deleted user simply has no entry, so the UI degrades to
 * its "former colleague" fallback rather than rendering a bare id or crashing —
 * `content_visibility_grants.grant_value` is loose text with no FK, so this is
 * a real state, not a defensive hypothetical.
 */
export async function resolveGrantLabels(
  grants: VisibilityGrant[]
): Promise<Record<string, string>> {
  const userIds = [
    ...new Set(
      grants
        .filter((g) => g.kind === "user")
        .map((g) => Number(g.value))
        // A non-numeric or non-positive value cannot match a users.id. Filtering
        // here keeps a malformed row from turning the whole lookup into a
        // driver-level type error.
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  if (userIds.length === 0) return {};

  const rows = await executeQuery(
    (db: DrizzleDB) =>
      db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(inArray(users.id, userIds)),
    "content.resolveGrantLabels"
  );

  const labels: Record<string, string> = {};
  for (const row of rows) {
    const name = [row.firstName, row.lastName]
      .filter((part) => (part ?? "").trim().length > 0)
      .join(" ")
      .trim();
    // Full email (not just the local part) is the fallback here, unlike the
    // library card's `ownerName`. That one renders to every viewer; this renders
    // only to an editor choosing who may read their document, where telling two
    // people with the same name apart is the entire job.
    //
    // A row with neither a name nor an email contributes NO entry, so the UI
    // falls through to its own fallback copy rather than showing a blank chip.
    const label = name.length > 0 ? name : (row.email ?? "");
    if (label.length > 0) {
      labels[grantLabelKey("user", String(row.id))] = label;
    }
  }
  return labels;
}
