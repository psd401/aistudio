/**
 * Atrium provenance footer (reader)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1, spec §18.2). A pure server component
 * that summarizes an object's authorship history into the reader's provenance
 * footer: whether any version was AI-drafted (an `agent` author) and whether any
 * version was human-reviewed (a `human` author), plus the head version number.
 *
 * Provenance is a per-version property (`content_versions.author_actor`), so the
 * footer reflects the whole history of the object, not just the live version: a
 * document drafted by an agent and then edited by a human shows BOTH badges.
 *
 * The badge `data-author` values ("agent" / "human") are the exact tokens the
 * shared stylesheet styles (`styles/atrium-content.css` — provenance palette:
 * purple = agent, green = human). Keep them in sync with that CSS.
 */

import { desc, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentVersions } from "@/lib/db/schema";

interface ProvenanceFooterProps {
  /** The `content_objects.id` (UUID) whose version history is summarized. */
  objectId: string;
}

/**
 * Render the reader's provenance footer for an object. Async server component:
 * it queries `content_versions` directly (no client JS), so the provenance
 * summary is computed at render time on the server.
 */
export async function ProvenanceFooter({
  objectId,
}: ProvenanceFooterProps): Promise<React.JSX.Element> {
  // Pull every version's author grain + number for this object. Ordered by
  // version number desc so the first row is the head (highest version number).
  const versions = await executeQuery(
    (db) =>
      db
        .select({
          authorActor: contentVersions.authorActor,
          versionNumber: contentVersions.versionNumber,
        })
        .from(contentVersions)
        .where(eq(contentVersions.objectId, objectId))
        .orderBy(desc(contentVersions.versionNumber)),
    "atrium.provenanceFooter"
  );

  // AI-drafted = any version authored by an agent; human-reviewed = any version
  // authored by a human. Both can be true (agent draft, human edit).
  const aiDrafted = versions.some((v) => v.authorActor === "agent");
  const humanReviewed = versions.some((v) => v.authorActor === "human");
  const maxVersionNumber = versions[0]?.versionNumber ?? null;

  return (
    <footer className="atrium-provenance-footer">
      {aiDrafted && (
        <span className="atrium-provenance-badge" data-author="agent">
          AI-drafted
        </span>
      )}
      {humanReviewed && (
        <span className="atrium-provenance-badge" data-author="human">
          Human-reviewed
        </span>
      )}
      {maxVersionNumber !== null && (
        <span>Last updated v{maxVersionNumber}</span>
      )}
    </footer>
  );
}
