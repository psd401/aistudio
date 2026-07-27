import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export type RepositoryMigrationMode =
  "dry_run" | "backfill" | "reconcile" | "rollback";

export type RepositoryMigrationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "blocked"
  | "rolled_back";

export type RepositoryMigrationSourceKind =
  "repository_item" | "nexus_document" | "assistant_pdf_job";

export interface RepositoryMigrationCursor {
  repository_item?: number;
  nexus_document?: number;
  assistant_pdf_job?: number;
}

export interface RepositoryMigrationSnapshot {
  maximumIds?: Partial<Record<RepositoryMigrationSourceKind, number>>;
  counts?: Partial<Record<RepositoryMigrationSourceKind, number>>;
  rollbackDrill?: boolean;
  migrationItemId?: string;
  canonicalItemId?: number;
  parentRunId?: string;
}

export interface RepositoryMigrationMetrics {
  discovered?: number;
  migrated?: number;
  verified?: number;
  mismatched?: number;
  failed?: number;
  unrecoverable?: number;
  excluded?: number;
  rolledBack?: number;
}

export const repositoryMigrationRuns = pgTable(
  "repository_migration_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mode: varchar("mode", { length: 24 })
      .$type<RepositoryMigrationMode>()
      .notNull(),
    status: varchar("status", { length: 32 })
      .$type<RepositoryMigrationRunStatus>()
      .default("queued")
      .notNull(),
    requestedBy: integer("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceKinds: jsonb("source_kinds")
      .$type<RepositoryMigrationSourceKind[]>()
      .default([])
      .notNull(),
    cursor: jsonb("cursor")
      .$type<RepositoryMigrationCursor>()
      .default({})
      .notNull(),
    snapshot: jsonb("snapshot")
      .$type<RepositoryMigrationSnapshot>()
      .default({})
      .notNull(),
    metrics: jsonb("metrics")
      .$type<RepositoryMigrationMetrics>()
      .default({})
      .notNull(),
    recoveryWindowEndsAt: timestamp("recovery_window_ends_at", {
      withTimezone: true,
    }),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_repository_migration_runs_status_created").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export type RepositoryMigrationRunRow =
  typeof repositoryMigrationRuns.$inferSelect;
export type NewRepositoryMigrationRunRow =
  typeof repositoryMigrationRuns.$inferInsert;
