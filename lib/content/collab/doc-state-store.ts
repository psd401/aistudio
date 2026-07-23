/**
 * Atrium live document state store (Postgres)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Durable persistence for the live Yjs
 * CRDT document in `atrium_doc_state` (migration 086). The y-websocket-protocol
 * collab server loads from here on cold start and writes back (debounced) on change.
 *
 * `y_state` is the authoritative encoded Y.Doc (Y.encodeStateAsUpdate). `markdown`
 * is a best-effort projection: it is set on initial seed (which holds the draft
 * markdown), but human-typing persists leave it untouched — the authoritative
 * markdown for a snapshot comes from the editor client at snapshot time, so this
 * column is a convenience/seed-base only.
 */

import { eq, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { atriumDocState } from "@/lib/db/schema";

export interface DocStateRow {
  yState: Buffer;
  markdown: string;
  revision: number;
}

/**
 * Load the persisted state for a document. Returns `null` when the document has
 * never been stored (not-found). Throws on a real database error — callers must
 * not use `.catch(() => null)` here, as that would collapse a DB outage into a
 * silent "unseen document" and trigger an unnecessary seed write on every request.
 */
export async function loadDocState(objectId: string): Promise<DocStateRow | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          yState: atriumDocState.yState,
          markdown: atriumDocState.markdown,
          revision: atriumDocState.revision,
        })
        .from(atriumDocState)
        .where(eq(atriumDocState.objectId, objectId))
        .limit(1),
    "collab.loadDocState"
  );
  return rows[0] ?? null;
}

/**
 * Upsert the encoded Y.Doc state. `markdown` is optional — pass it on seed /
 * agent-bridge writes (which know the markdown), omit it on plain human-edit
 * persists to leave the existing projection untouched. `revision` is bumped
 * monotonically on every write.
 */
export async function saveDocState(
  objectId: string,
  yState: Uint8Array,
  markdown?: string
): Promise<void> {
  const buf = Buffer.from(yState);
  await executeQuery(
    (db) =>
      db
        .insert(atriumDocState)
        .values({
          objectId,
          yState: buf,
          markdown: markdown ?? "",
          revision: 1,
        })
        .onConflictDoUpdate({
          target: atriumDocState.objectId,
          set: {
            yState: buf,
            // Only overwrite the projection when a fresh markdown is supplied.
            markdown: markdown ?? sql`${atriumDocState.markdown}`,
            revision: sql`${atriumDocState.revision} + 1`,
            updatedAt: new Date(),
          },
        }),
    "collab.saveDocState"
  );
}
