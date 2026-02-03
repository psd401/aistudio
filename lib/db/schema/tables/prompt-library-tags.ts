/**
 * Prompt Library Tags Table Schema
 * Many-to-many relationship between prompts and tags
 */

import {
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { promptLibrary } from "./prompt-library";
import { promptTags } from "./prompt-tags";

export const promptLibraryTags = pgTable(
  "prompt_library_tags",
  {
    promptId: uuid("prompt_id")
      .references(() => promptLibrary.id)
      .notNull(),
    tagId: integer("tag_id")
      .references(() => promptTags.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.promptId, table.tagId] }),
  })
);
