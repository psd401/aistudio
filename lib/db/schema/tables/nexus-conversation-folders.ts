/**
 * Nexus Conversation Folders Table Schema
 * Junction table for conversation-folder many-to-many relationship
 */

import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { nexusConversations } from "./nexus-conversations";
import { nexusFolders } from "./nexus-folders";

export const nexusConversationFolders = pgTable(
  "nexus_conversation_folders",
  {
    conversationId: uuid("conversation_id")
      .references(() => nexusConversations.id)
      .notNull(),
    folderId: uuid("folder_id")
      .references(() => nexusFolders.id)
      .notNull(),
    position: integer("position").default(0),
    pinned: boolean("pinned").default(false),
    archivedAt: timestamp("archived_at"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.conversationId, table.folderId] }),
  })
);
