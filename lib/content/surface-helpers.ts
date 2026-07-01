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

async function collectionIdByColumn(
  column: typeof contentCollections.id | typeof contentCollections.slug,
  value: string
): Promise<string | undefined> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: contentCollections.id })
        .from(contentCollections)
        .where(eq(column, value))
        .limit(1),
    "atrium.resolveCollectionId"
  );
  return rows[0]?.id;
}

/**
 * Resolve a `collection` argument (a slug OR a uuid) to a collection id, or
 * `undefined` when none is supplied. Throws a user-facing `ValidationError`
 * (→ 400) when it matches no collection.
 *
 * EXISTENCE is validated here — not deferred to the service. `contentService.create`
 * skips its own collection check when an explicit `visibility.level` is supplied
 * (the `??` short-circuits `collectionDefault`), so an unvalidated id would reach
 * the INSERT and surface as an opaque FK-violation 500 instead of a 400. A
 * uuid-shaped input is tried as an id first, then as a slug (a slug can itself be
 * uuid-shaped) — mirroring `loadByIdOrSlug`.
 */
export async function resolveCollectionId(
  collection?: string | null
): Promise<string | undefined> {
  if (!collection) return undefined;
  if (UUID_RE.test(collection)) {
    const byId = await collectionIdByColumn(contentCollections.id, collection);
    if (byId) return byId;
    // Fall through: the value may be a uuid-shaped slug rather than an id.
  }
  const bySlug = await collectionIdByColumn(contentCollections.slug, collection);
  if (!bySlug) {
    throw new ValidationError("Collection not found", { collection });
  }
  return bySlug;
}

/** The internal reader deep link for a content object, returned in results. */
export function contentDeepLink(slug: string): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/c/${slug}`;
}
