/**
 * Durable synchronized-source state for repository connectors (Epic #1261,
 * Google Workspace workstream #1262).
 *
 * Repository ACLs remain authoritative for content access. Connector
 * credentials are stored separately as encrypted values and are never copied
 * into repository metadata, source metadata, logs, or worker messages.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";
import { repositoryItems } from "./repository-items";
import { repositoryItemVersions } from "./repository-item-versions";
import { users } from "./users";

export type RepositoryConnectorProvider = "google_drive";
export type RepositoryConnectorAuthMode = "personal_oauth" | "shared_drive_wif";
export type RepositoryConnectorStatus =
  "pending" | "active" | "degraded" | "paused" | "revoked";
export type RepositoryConnectorSelectionKind = "file" | "folder" | "drive";
export type RepositoryConnectorSourceStatus =
  "active" | "missing" | "access_lost" | "deleted" | "unsupported" | "failed";
export type RepositoryConnectorSyncTrigger =
  "initial" | "schedule" | "notification" | "manual" | "recovery";
export type RepositoryConnectorSyncStatus = "running" | "succeeded" | "failed";

export interface RepositoryConnectorMetadata {
  oauthEmail?: string;
  googleDriveName?: string;
  lastNotificationState?: string;
}

export interface RepositoryConnectorSourceMetadata {
  webViewLink?: string;
  iconLink?: string;
  exportMimeType?: string;
  originalMimeType?: string;
  ownerNames?: string[];
  selectedVia?: string[];
  pendingDownloadOperation?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export const repositoryConnectorCredentials = pgTable(
  "repository_connector_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    provider: varchar("provider", { length: 32 })
      .$type<RepositoryConnectorProvider>()
      .notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    grantedScopes: text("granted_scopes").array().default([]).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_repository_connector_credentials_user").on(
      table.repositoryId,
      table.userId,
      table.provider,
    ),
    check(
      "chk_repository_connector_credentials_provider",
      sql`${table.provider} IN ('google_drive')`,
    ),
  ],
);

export const repositoryConnectors = pgTable(
  "repository_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    provider: varchar("provider", { length: 32 })
      .$type<RepositoryConnectorProvider>()
      .notNull(),
    authMode: varchar("auth_mode", { length: 32 })
      .$type<RepositoryConnectorAuthMode>()
      .notNull(),
    createdBy: integer("created_by")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    credentialId: uuid("credential_id").references(
      () => repositoryConnectorCredentials.id,
      { onDelete: "set null" },
    ),
    displayName: text("display_name").notNull(),
    sharedDriveId: text("shared_drive_id"),
    status: varchar("status", { length: 20 })
      .$type<RepositoryConnectorStatus>()
      .default("pending")
      .notNull(),
    selectionRevision: integer("selection_revision").default(0).notNull(),
    cursor: text("cursor"),
    watchChannelId: uuid("watch_channel_id"),
    watchResourceId: text("watch_resource_id"),
    watchTokenHash: varchar("watch_token_hash", { length: 64 }),
    watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
    lastNotificationNumber: bigint("last_notification_number", {
      mode: "bigint",
    }),
    syncIntervalMinutes: integer("sync_interval_minutes").default(15).notNull(),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 128 }),
    lastErrorMessage: text("last_error_message"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    metadata: jsonb("metadata")
      .$type<RepositoryConnectorMetadata>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_repository_connectors_due").on(table.status, table.nextSyncAt),
    index("idx_repository_connectors_repository").on(table.repositoryId),
    uniqueIndex("uq_repository_connectors_personal")
      .on(table.repositoryId, table.provider, table.authMode, table.createdBy)
      .where(sql`${table.authMode} = 'personal_oauth'`),
    uniqueIndex("uq_repository_connectors_shared_drive")
      .on(table.repositoryId, table.provider, table.sharedDriveId)
      .where(sql`${table.authMode} = 'shared_drive_wif'`),
    uniqueIndex("uq_repository_connectors_watch_channel")
      .on(table.watchChannelId)
      .where(sql`${table.watchChannelId} IS NOT NULL`),
    check(
      "chk_repository_connectors_provider",
      sql`${table.provider} IN ('google_drive')`,
    ),
    check(
      "chk_repository_connectors_auth_mode",
      sql`${table.authMode} IN ('personal_oauth', 'shared_drive_wif')`,
    ),
    check(
      "chk_repository_connectors_status",
      sql`${table.status} IN ('pending', 'active', 'degraded', 'paused', 'revoked')`,
    ),
    check(
      "chk_repository_connectors_auth_shape",
      sql`(
        (${table.authMode} = 'personal_oauth' AND ${table.credentialId} IS NOT NULL AND ${table.sharedDriveId} IS NULL)
        OR
        (${table.authMode} = 'shared_drive_wif' AND ${table.credentialId} IS NULL AND ${table.sharedDriveId} IS NOT NULL)
      )`,
    ),
    check(
      "chk_repository_connectors_sync_interval",
      sql`${table.syncIntervalMinutes} BETWEEN 5 AND 1440`,
    ),
    check(
      "chk_repository_connectors_failure_count",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "chk_repository_connectors_selection_revision",
      sql`${table.selectionRevision} >= 0`,
    ),
  ],
);

export const repositoryConnectorSelections = pgTable(
  "repository_connector_selections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: uuid("connector_id")
      .references(() => repositoryConnectors.id, { onDelete: "cascade" })
      .notNull(),
    externalId: text("external_id").notNull(),
    selectionKind: varchar("selection_kind", { length: 16 })
      .$type<RepositoryConnectorSelectionKind>()
      .notNull(),
    displayName: text("display_name").notNull(),
    includeDescendants: boolean("include_descendants").default(true).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_repository_connector_selections_external").on(
      table.connectorId,
      table.externalId,
    ),
    index("idx_repository_connector_selections_active").on(
      table.connectorId,
      table.active,
    ),
    check(
      "chk_repository_connector_selections_kind",
      sql`${table.selectionKind} IN ('file', 'folder', 'drive')`,
    ),
  ],
);

export const repositoryConnectorSources = pgTable(
  "repository_connector_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: uuid("connector_id")
      .references(() => repositoryConnectors.id, { onDelete: "cascade" })
      .notNull(),
    repositoryItemId: integer("repository_item_id")
      .references(() => repositoryItems.id, { onDelete: "cascade" })
      .notNull(),
    externalId: text("external_id").notNull(),
    driveId: text("drive_id"),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    parentIds: text("parent_ids").array().default([]).notNull(),
    sourceRevision: text("source_revision"),
    modifiedTime: timestamp("modified_time", { withTimezone: true }),
    checksum: varchar("checksum", { length: 128 }),
    currentItemVersionId: uuid("current_item_version_id").references(
      () => repositoryItemVersions.id,
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 20 })
      .$type<RepositoryConnectorSourceStatus>()
      .default("active")
      .notNull(),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadata: jsonb("metadata")
      .$type<RepositoryConnectorSourceMetadata>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_repository_connector_sources_external").on(
      table.connectorId,
      table.externalId,
    ),
    uniqueIndex("uq_repository_connector_sources_item").on(
      table.repositoryItemId,
    ),
    index("idx_repository_connector_sources_missing").on(
      table.status,
      table.missingSince,
    ),
    check(
      "chk_repository_connector_sources_status",
      sql`${table.status} IN ('active', 'missing', 'access_lost', 'deleted', 'unsupported', 'failed')`,
    ),
  ],
);

export const repositoryConnectorSyncRuns = pgTable(
  "repository_connector_sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: uuid("connector_id")
      .references(() => repositoryConnectors.id, { onDelete: "cascade" })
      .notNull(),
    trigger: varchar("trigger", { length: 20 })
      .$type<RepositoryConnectorSyncTrigger>()
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<RepositoryConnectorSyncStatus>()
      .default("running")
      .notNull(),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    discoveredCount: integer("discovered_count").default(0).notNull(),
    createdCount: integer("created_count").default(0).notNull(),
    updatedCount: integer("updated_count").default(0).notNull(),
    unchangedCount: integer("unchanged_count").default(0).notNull(),
    missingCount: integer("missing_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    errorCode: varchar("error_code", { length: 128 }),
    errorMessage: text("error_message"),
    traceId: varchar("trace_id", { length: 128 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_repository_connector_sync_runs_connector").on(
      table.connectorId,
      table.startedAt,
    ),
    check(
      "chk_repository_connector_sync_runs_trigger",
      sql`${table.trigger} IN ('initial', 'schedule', 'notification', 'manual', 'recovery')`,
    ),
    check(
      "chk_repository_connector_sync_runs_status",
      sql`${table.status} IN ('running', 'succeeded', 'failed')`,
    ),
    check(
      "chk_repository_connector_sync_runs_counts",
      sql`${table.discoveredCount} >= 0
        AND ${table.createdCount} >= 0
        AND ${table.updatedCount} >= 0
        AND ${table.unchangedCount} >= 0
        AND ${table.missingCount} >= 0
        AND ${table.failedCount} >= 0`,
    ),
  ],
);

export type RepositoryConnectorRow = typeof repositoryConnectors.$inferSelect;
export type RepositoryConnectorCredentialRow =
  typeof repositoryConnectorCredentials.$inferSelect;
export type RepositoryConnectorSelectionRow =
  typeof repositoryConnectorSelections.$inferSelect;
export type RepositoryConnectorSourceRow =
  typeof repositoryConnectorSources.$inferSelect;
export type RepositoryConnectorSyncRunRow =
  typeof repositoryConnectorSyncRuns.$inferSelect;
