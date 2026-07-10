/**
 * Atrium provenance footer (reader)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1, spec §18.2). A pure server component
 * that summarizes an object's authorship history into the reader's provenance
 * footer: whether any version was AI-drafted (an `agent` author) and whether any
 * version was human-reviewed (a `human` author), plus the head version number.
 *
 * Provenance is a per-version property (`content_versions.author_actor`), so the
 * footer reflects the authorship history of the PUBLISHED lineage: a document
 * drafted by an agent and then edited by a human before publication shows BOTH
 * badges.
 *
 * Scope (Phase 7, #1057): when `publishedVersionNumber` is supplied (the reader
 * routes always render one specific published version, whose number they already
 * hold), the summary is bounded to versions up to and including that number. This
 * is required on the ANONYMOUS public reader (`/p/[slug]`): without the bound, a
 * draft `v3` created after the published `v2` would leak its version number and
 * author badges to the public via `MAX`/`BOOL_OR` over the whole object. The
 * internal reader passes it too, so both describe the version being read, not
 * unpublished future drafts. Omitting the prop falls back to whole-object history
 * (unbounded).
 *
 * The badge `data-author` values ("agent" / "human") are the exact tokens the
 * shared stylesheet styles (`styles/atrium-content.css` — provenance palette:
 * purple = agent, green = human). Keep them in sync with that CSS.
 */

import { and, eq, lte, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentVersions } from "@/lib/db/schema";

interface ProvenanceFooterProps {
  /** The `content_objects.id` (UUID) whose version history is summarized. */
  objectId: string;
  /**
   * The `version_number` of the version being rendered. When present, the summary
   * is bounded to versions with `version_number <=` this number, so drafts created
   * after publication are never reflected (critical on the public reader). The
   * reader routes already hold this number, so no id→number subquery is needed.
   */
  publishedVersionNumber?: number;
}

/**
 * Render the reader's provenance footer for an object. Async server component:
 * it queries `content_versions` directly (no client JS), so the provenance
 * summary is computed at render time on the server.
 */
export async function ProvenanceFooter({
  objectId,
  publishedVersionNumber,
}: ProvenanceFooterProps): Promise<React.JSX.Element> {
  // Bound the summary to the published lineage when the rendered version is known:
  // version_number <= the published version's number. Excludes post-publication
  // drafts so they never surface on a reader (see the public-leak note above).
  const versionBound =
    publishedVersionNumber !== undefined
      ? lte(contentVersions.versionNumber, publishedVersionNumber)
      : undefined;

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
        .where(and(eq(contentVersions.objectId, objectId), versionBound)),
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
