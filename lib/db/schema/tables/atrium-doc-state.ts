/**
 * Atrium live document state (Yjs CRDT)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1 — document path + real-time collab).
 * One live collaborative document per `document` content object. The
 * y-websocket-protocol collab server (`lib/content/collab/collab-server.ts`)
 * hydrates a `Y.Doc` from `yState` on first connection and persists the encoded
 * state back here, debounced, on change. Cross-ECS-task fan-out runs through
 * Redis; this row is the durable source of truth on cold load and the input to
 * immutable version snapshots (`content_versions`).
 *
 * - `yState`   — encoded full `Y.Doc` state (`Y.encodeStateAsUpdate`). bytea;
 *                postgres.js returns a `Buffer` directly usable by `Y.applyUpdate`.
 * - `markdown` — best-effort markdown projection, set on initial seed only.
 *                Human-typing persists do NOT re-derive markdown from the Y.Doc;
 *                the authoritative markdown for snapshots comes from the editor
 *                client at snapshot time.
 * - `revision` — monotonic persist counter; the agent bridge's optimistic-
 *                concurrency token.
 *
 * SQL: migration 086. See docs/features/atrium-design-spec.md §13.2.
 */

import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { bytea } from "../custom-types";

export const atriumDocState = pgTable("atrium_doc_state", {
  objectId: uuid("object_id")
    .references(() => contentObjects.id, { onDelete: "cascade" })
    .primaryKey(),
  yState: bytea("y_state").notNull(),
  markdown: text("markdown").notNull().default(""),
  // mode:"number" — a per-document persist counter; far below 2^53.
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AtriumDocStateRow = typeof atriumDocState.$inferSelect;
export type NewAtriumDocStateRow = typeof atriumDocState.$inferInsert;
