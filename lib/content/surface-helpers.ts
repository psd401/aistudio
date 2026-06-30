/**
 * Atrium surface helpers (shared by REST v1 + MCP)
 *
 * Issue #1055 (Epic #1059, Atrium Phase 5). Small utilities both agent surfaces
 * use so behavior stays identical: resolving a collection slug-or-id to an id,
 * and building a reader deep link returned in tool/route results.
 */

import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections } from "@/lib/db/schema";
import { ValidationError } from "./errors";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a `collection` argument (a slug OR a uuid) to a collection id, or
 * `undefined` when none is supplied. A uuid is returned as-is (the service's
 * `assertCollectionExists` validates it); a slug is looked up and throws a
 * user-facing `ValidationError` when it matches no collection.
 */
export async function resolveCollectionId(
  collection?: string | null
): Promise<string | undefined> {
  if (!collection) return undefined;
  if (UUID_RE.test(collection)) return collection;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: contentCollections.id })
        .from(contentCollections)
        .where(eq(contentCollections.slug, collection))
        .limit(1),
    "atrium.resolveCollectionId"
  );
  if (!rows[0]) {
    throw new ValidationError("Collection not found", { collection });
  }
  return rows[0].id;
}

/** The internal reader deep link for a content object, returned in results. */
export function contentDeepLink(slug: string): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/c/${slug}`;
}
