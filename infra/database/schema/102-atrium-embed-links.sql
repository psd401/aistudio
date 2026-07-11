-- Migration 102: Atrium embedded-artifact backlinks (Epic #1059 Meridian slice D)
--
-- Records the "which documents embed this artifact" edges that back the artifact
-- viewer's "EMBEDDED IN" rail card. One row per (document, artifact) embed edge.
--
-- An embedded artifact is persisted in a document's canonical markdown as a leaf
-- directive `::atrium-artifact{id="<uuid>"}` (lib/content/embed-directive.ts). The
-- shared snapshot write primitive (versionService.snapshotInTx) parses those ids
-- out of the document body on every version write and REPLACES this document's
-- rows (delete-then-insert in the same transaction), so the table always reflects
-- the latest snapshot. The artifact rail then queries by `artifact_object_id`.
--
-- Both FKs ON DELETE CASCADE: deleting either the embedding document OR the
-- embedded artifact removes the stale edge automatically, so the rail never lists
-- a dangling reference. A UNIQUE(document, artifact) collapses repeat embeds of the
-- same artifact in one document to a single edge (the snapshot sync is idempotent).
--
-- ADDITIVE and idempotent (IF NOT EXISTS, mirroring 090/094/095/096/098). No DO $$
-- blocks — the migration runner's statement splitter cannot handle dollar-quoted
-- blocks (see 079/085/086). No updated_at column, so no trigger is needed.

CREATE TABLE IF NOT EXISTS content_embed_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The document that contains the embed directive.
  document_object_id  uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  -- The artifact the document embeds.
  artifact_object_id  uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_content_embed_links UNIQUE (document_object_id, artifact_object_id)
);

-- "EMBEDDED IN" lookup: given an artifact, find every document embedding it.
CREATE INDEX IF NOT EXISTS idx_content_embed_links_artifact
  ON content_embed_links (artifact_object_id);

-- Snapshot sync deletes a document's rows before re-inserting; index the delete key.
CREATE INDEX IF NOT EXISTS idx_content_embed_links_document
  ON content_embed_links (document_object_id);
