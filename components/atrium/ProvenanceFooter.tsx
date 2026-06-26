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

import { eq, sql } from "drizzle-orm";
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
  // Aggregate query: only three facts needed, not every row. MAX + BOOL_OR avoids
  // loading the full version history on objects with many versions.
  const [agg] = await executeQuery(
    (db) =>
      db
        .select({
          maxVersionNumber:
            sql<number | null>`MAX(${contentVersions.versionNumber})`.as("max_version_number"),
          aiDrafted:
            sql<boolean>`BOOL_OR(${contentVersions.authorActor} = 'agent')`.as("ai_drafted"),
          humanReviewed:
            sql<boolean>`BOOL_OR(${contentVersions.authorActor} = 'human')`.as("human_reviewed"),
        })
        .from(contentVersions)
        .where(eq(contentVersions.objectId, objectId)),
    "atrium.provenanceFooter"
  );

  const aiDrafted = agg?.aiDrafted ?? false;
  const humanReviewed = agg?.humanReviewed ?? false;
  const maxVersionNumber = agg?.maxVersionNumber ?? null;

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
