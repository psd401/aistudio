/**
 * Append-only records submitted by authenticated Atrium artifacts (#1516).
 *
 * Records are scoped to a content object and attributed to the session user
 * that submitted them. If that user is later hard-deleted, attribution is set
 * to null while the record remains. They intentionally have no `updated_at` or
 * retention column: artifact data is immutable until its content is deleted.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ArtifactDataPayload } from "@/lib/db/types/jsonb";
import { contentObjects } from "./content-objects";
import { users } from "./users";

export const contentDataRecords = pgTable(
  "content_data_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentId: uuid("content_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    namespace: varchar("namespace", { length: 64 }).notNull(),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").$type<ArtifactDataPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_content_data_records_lookup").on(
      t.contentId,
      t.namespace,
      t.createdAt.desc(),
    ),
    index("idx_content_data_records_user").on(
      t.userId,
      t.contentId,
      t.namespace,
    ),
    check(
      "chk_content_data_records_namespace",
      sql`${t.namespace} ~ '^[a-z0-9_-]{1,64}$'`,
    ),
  ],
);

export type ContentDataRecordRow = typeof contentDataRecords.$inferSelect;
export type NewContentDataRecordRow = typeof contentDataRecords.$inferInsert;
