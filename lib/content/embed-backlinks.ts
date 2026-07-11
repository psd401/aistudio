/**
 * Atrium embed backlinks — "EMBEDDED IN" query (Epic #1059 Meridian slice D)
 *
 * Lists the documents that embed a given artifact, for the artifact viewer's
 * "EMBEDDED IN" rail card. Reads the `content_embed_links` backlink table
 * (maintained by the snapshot write primitive) and filters the candidate documents
 * to those the viewer may actually see — so the rail never reveals the existence of
 * a document the caller has no access to. Archived documents are omitted (they are
 * offline everywhere).
 */

import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentEmbedLinks, contentObjects } from "@/lib/db/schema";
import { visibilityService } from "./visibility-service";
import { isArtifactId } from "./embed-directive";
import type { Requester } from "./types";

/** A document that embeds the artifact (viewer-visible, non-archived). */
export interface EmbeddingDocument {
  id: string;
  title: string;
  slug: string;
}

/**
 * The documents embedding `artifactId` that `requester` may view (non-archived),
 * newest-embed first. Load-then-filter by `canView`: backlink lists are small (a
 * handful of docs), so per-row visibility checks are cheap and keep the gate
 * identical to every other content read.
 */
export async function listEmbeddingDocuments(
  requester: Requester,
  artifactId: string
): Promise<EmbeddingDocument[]> {
  if (!isArtifactId(artifactId)) return [];

  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          title: contentObjects.title,
          slug: contentObjects.slug,
          ownerUserId: contentObjects.ownerUserId,
          visibilityLevel: contentObjects.visibilityLevel,
          status: contentObjects.status,
        })
        .from(contentEmbedLinks)
        .innerJoin(
          contentObjects,
          eq(contentObjects.id, contentEmbedLinks.documentObjectId)
        )
        .where(eq(contentEmbedLinks.artifactObjectId, artifactId)),
    "atrium.embed.listEmbeddingDocuments"
  );

  const out: EmbeddingDocument[] = [];
  for (const r of rows) {
    if (r.status === "archived") continue;
    const viewable = await visibilityService.canView(requester, {
      id: r.id,
      ownerUserId: r.ownerUserId,
      visibilityLevel: r.visibilityLevel,
    });
    if (viewable) out.push({ id: r.id, title: r.title, slug: r.slug });
  }
  return out;
}
