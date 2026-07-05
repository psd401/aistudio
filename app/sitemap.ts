/**
 * Sitemap for the Atrium public reader (`/p/[slug]`) — Epic #1059.
 *
 * Enumerates ONLY objects the anonymous public route would actually render,
 * mirroring the `/p/[slug]` gate exactly (plus the `status = 'published'`
 * lifecycle filter, a strict subset of that gate):
 *   - `content_objects.visibility_level = 'public'`  (the strict public gate)
 *   - a LIVE `public_web` publication                 (destination + status)
 *   - `content_objects.status = 'published'`
 *
 * Because every condition here is at least as strict as the page's own gate,
 * the sitemap can never name a URL the reader would 404 (which would both leak
 * existence and rack up crawler soft-404s).
 *
 * Fail-soft: any DB error yields an EMPTY sitemap (log.warn) — a broken sitemap
 * must never take the app down. A missing `ATRIUM_PUBLIC_BASE_URL` (the same
 * env `publicReaderLink` builds reader URLs from) also yields an empty sitemap:
 * relative URLs are invalid in the sitemap protocol.
 *
 * `force-dynamic`: the live-publication set changes at publish/unpublish time,
 * so the sitemap is read per request (like the reader page) rather than baked
 * at build time — a build-time snapshot would keep advertising unpublished
 * content (and the build environment has no database at all).
 */

import type { MetadataRoute } from "next";
import { and, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentObjects, contentPublications } from "@/lib/db/schema";
import { publicReaderLink } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const log = createLogger({ action: "atrium.sitemap" });

  // Same base the readers use (see surface-helpers publicReaderLink). Without
  // it, entries would be relative — invalid sitemap XML — so fail soft empty.
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    log.warn("ATRIUM_PUBLIC_BASE_URL not set; serving empty sitemap");
    return [];
  }

  try {
    const rows = await executeQuery(
      (db) =>
        db
          .select({
            slug: contentObjects.slug,
            updatedAt: contentObjects.updatedAt,
          })
          .from(contentObjects)
          .innerJoin(
            contentPublications,
            eq(contentPublications.objectId, contentObjects.id)
          )
          .where(
            and(
              // The /p/[slug] strict public gate, exactly:
              eq(contentObjects.visibilityLevel, "public"),
              eq(contentPublications.destination, "public_web"),
              eq(contentPublications.status, "live"),
              // Lifecycle subset guard (publish sets it; unpublish reverts it):
              eq(contentObjects.status, "published")
            )
          ),
      "atrium.sitemap.publicObjects"
    );

    return rows.map((row) => ({
      // publicReaderLink is the SINGLE builder for /p/ URLs (the same one the
      // publish adapter records as external_ref) — no second URL format here.
      url: publicReaderLink(row.slug),
      ...(row.updatedAt ? { lastModified: row.updatedAt } : {}),
    }));
  } catch (error) {
    // Fail soft: an unreachable DB must degrade to an empty sitemap, never a 500.
    log.warn("Failed to build sitemap; serving empty sitemap", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
