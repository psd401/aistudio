/**
 * Immutable authored raster assets and their version reference set (#1284).
 *
 * Uploads land at a temporary key. Only decoded, normalized bytes are written to
 * `objectKey`, and that canonical key is never exposed through an API response.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { actorKindEnum } from "../enums";
import { agentIdentities } from "./agent-identities";
import { contentObjects } from "./content-objects";
import { contentVersions } from "./content-versions";
import { users } from "./users";

export type ContentAssetState =
  | "pending"
  | "quarantined"
  | "ready"
  | "rejected"
  | "deleted";
export type ContentAssetPurpose = "capture_step" | "document_image";

export interface ContentAssetInspection {
  processorVersion?: string;
  detectedContentType?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  normalizedByteLength?: number;
  normalizedSha256?: string;
  metadataStripped?: boolean;
  rejectionCode?: string;
}

export const contentAssets = pgTable(
  "content_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    objectId: uuid("object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    uploaderActor: actorKindEnum("uploader_actor").notNull(),
    uploaderUserId: integer("uploader_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    uploaderAgentId: uuid("uploader_agent_id").references(
      () => agentIdentities.id,
      { onDelete: "set null" }
    ),
    filename: varchar("filename", { length: 255 }).notNull(),
    objectKey: text("object_key").notNull().unique(),
    uploadKey: text("upload_key").notNull().unique(),
    contentType: varchar("content_type", { length: 32 }).notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: varchar("sha256", { length: 43 }).notNull(),
    width: integer("width"),
    height: integer("height"),
    purpose: varchar("purpose", { length: 32 })
      .$type<ContentAssetPurpose>()
      .notNull(),
    state: varchar("state", { length: 24 })
      .$type<ContentAssetState>()
      .default("pending")
      .notNull(),
    inspection: jsonb("inspection").$type<ContentAssetInspection>(),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }).notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_content_assets_object_created").on(t.objectId, t.createdAt),
    index("idx_content_assets_pending_expiry").on(t.state, t.uploadExpiresAt),
  ]
);

export const contentVersionAssets = pgTable(
  "content_version_assets",
  {
    versionId: uuid("version_id")
      .references(() => contentVersions.id, { onDelete: "cascade" })
      .notNull(),
    assetId: uuid("asset_id")
      .references(() => contentAssets.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "pk_content_version_assets",
      columns: [t.versionId, t.assetId],
    }),
    index("idx_content_version_assets_asset").on(t.assetId),
  ]
);

export type ContentAssetRow = typeof contentAssets.$inferSelect;
