import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { knowledgeRepositories } from "./knowledge-repositories";
import { repositoryItems } from "./repository-items";
import { repositoryItemVersions } from "./repository-item-versions";
import {
  repositoryMigrationRuns,
  type RepositoryMigrationSourceKind,
} from "./repository-migration-runs";

export type RepositoryMigrationItemStatus =
  | "pending"
  | "migrating"
  | "migrated"
  | "verified"
  | "mismatch"
  | "failed"
  | "unrecoverable"
  | "excluded"
  | "rolled_back";

export interface RepositoryMigrationItemMetadata {
  originalFileName?: string;
  declaredContentType?: string;
  legacyConversationId?: string;
  createdRepository?: boolean;
  preexistingCanonicalVersion?: boolean;
  recoveredFromLegacySegments?: boolean;
  recoveredFromVerifiedDuplicateSourceId?: number;
  rollbackDrill?: boolean;
  approvedMismatchAt?: string;
  approvedMismatchBy?: number;
  approvedMismatchReason?: string;
  rollbackPrepared?: boolean;
  rollbackObjectKeys?: string[];
  exclusionReason?: string;
  excludedAt?: string;
  lastReconciledRunId?: string;
}

export const repositoryMigrationItems = pgTable(
  "repository_migration_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => repositoryMigrationRuns.id, { onDelete: "cascade" })
      .notNull(),
    originRunId: uuid("origin_run_id")
      .references(() => repositoryMigrationRuns.id, { onDelete: "cascade" })
      .notNull(),
    sourceKind: varchar("source_kind", { length: 32 })
      .$type<RepositoryMigrationSourceKind>()
      .notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    ownerId: integer("owner_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    legacyRepositoryId: integer("legacy_repository_id").references(
      () => knowledgeRepositories.id,
      { onDelete: "set null" },
    ),
    canonicalRepositoryId: integer("canonical_repository_id").references(
      () => knowledgeRepositories.id,
      { onDelete: "set null" },
    ),
    canonicalItemId: integer("canonical_item_id").references(
      () => repositoryItems.id,
      { onDelete: "set null" },
    ),
    canonicalVersionId: uuid("canonical_version_id").references(
      () => repositoryItemVersions.id,
      { onDelete: "set null" },
    ),
    sourceObjectKey: text("source_object_key"),
    canonicalObjectKey: text("canonical_object_key"),
    sourceRecordCount: integer("source_record_count"),
    canonicalRecordCount: integer("canonical_record_count"),
    sourceContentSha256: char("source_content_sha256", { length: 64 }),
    canonicalContentSha256: char("canonical_content_sha256", { length: 64 }),
    sourceObjectSha256: char("source_object_sha256", { length: 64 }),
    canonicalObjectSha256: char("canonical_object_sha256", { length: 64 }),
    status: varchar("status", { length: 24 })
      .$type<RepositoryMigrationItemStatus>()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastErrorCode: varchar("last_error_code", { length: 128 }),
    lastErrorMessage: text("last_error_message"),
    metadata: jsonb("metadata")
      .$type<RepositoryMigrationItemMetadata>()
      .default({})
      .notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("uq_repository_migration_source").on(
      table.sourceKind,
      table.sourceId,
    ),
    index("idx_repository_migration_items_run_status").on(
      table.runId,
      table.status,
      table.sourceKind,
      table.sourceId,
    ),
    index("idx_repository_migration_items_origin_run").on(
      table.originRunId,
      table.status,
    ),
    index("idx_repository_migration_items_canonical_item").on(
      table.canonicalItemId,
    ),
  ],
);

export type RepositoryMigrationItemRow =
  typeof repositoryMigrationItems.$inferSelect;
export type NewRepositoryMigrationItemRow =
  typeof repositoryMigrationItems.$inferInsert;
