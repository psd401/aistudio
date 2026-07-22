/** Durable, idempotent processing-stage jobs for repository item versions. */

import { sql } from "drizzle-orm";
import {
  check,
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
import { repositoryItemVersions } from "./repository-item-versions";

export type RepositoryProcessingStage =
  | "inspect"
  | "normalize"
  | "enrich"
  | "segment"
  | "embed"
  | "publish"
  | "purge";

export type RepositoryProcessingJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RepositoryProcessingMetrics {
  /** Transitional migration-122 handoff copied into the durable column by migration 123. */
  postDeployRecovery?: "unified-content-runtime-v2";
  /** Current managed-service wait, used to enforce a bounded deadline. */
  waitReason?:
    | "CONTENT_PLATFORM_DISABLED"
    | "AWAITING_SECURITY_SCAN"
    | "AWAITING_OCR"
    | "AWAITING_MEDIA_ANALYSIS";
  /** ISO timestamp at which the current managed-service wait began. */
  waitStartedAt?: string;
  durationMs?: number;
  inputBytes?: number;
  outputBytes?: number;
  pages?: number;
  segments?: number;
  provider?: string;
  modelId?: string;
  textractJobId?: string;
  textractObjectKey?: string;
  inputTokens?: number;
  outputTokens?: number;
  captionLatencyMs?: number;
  imageWidth?: number;
  imageHeight?: number;
  thumbnailBytes?: number;
  ocrLines?: number;
  bdaInvocationArn?: string;
  bdaSourceObjectKey?: string;
  bdaOutputPrefix?: string;
  bdaResultObjectKey?: string;
  mediaDurationMs?: number;
  mediaFormat?: string;
  mediaCodec?: string;
  mediaChannels?: number;
  frameRate?: number;
  frameWidth?: number;
  frameHeight?: number;
  wordCount?: number;
  topicCount?: number;
  shotCount?: number;
  chapterCount?: number;
  speakerCount?: number;
  estimatedCostUsd?: number;
}

export const repositoryProcessingJobs = pgTable(
  "repository_processing_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemVersionId: uuid("item_version_id")
      .references(() => repositoryItemVersions.id, { onDelete: "cascade" })
      .notNull(),
    stage: varchar("stage", { length: 20 })
      .$type<RepositoryProcessingStage>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<RepositoryProcessingJobStatus>()
      .default("pending")
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    attempt: integer("attempt").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseOwner: varchar("lease_owner", { length: 255 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    traceId: varchar("trace_id", { length: 128 }),
    lastErrorCode: varchar("last_error_code", { length: 128 }),
    lastErrorMessage: text("last_error_message"),
    /** Durable across stale worker writes; only the replacement runtime clears it. */
    postDeployRecovery: varchar("post_deploy_recovery", { length: 64 }).$type<
      "unified-content-runtime-v2"
    >(),
    metrics: jsonb("metrics")
      .$type<RepositoryProcessingMetrics>()
      .default({})
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_repository_processing_idempotency").on(t.idempotencyKey),
    index("idx_repository_processing_version").on(t.itemVersionId, t.createdAt),
    check(
      "ck_repository_processing_postdeploy_cancelled",
      sql`${t.postDeployRecovery} IS NULL OR ${t.status} = 'cancelled'`
    ),
    index("idx_repository_processing_postdeploy_recovery")
      .on(t.updatedAt, t.id)
      .where(sql`${t.postDeployRecovery} IS NOT NULL`),
  ]
);

export type RepositoryProcessingJobRow = typeof repositoryProcessingJobs.$inferSelect;
export type NewRepositoryProcessingJobRow = typeof repositoryProcessingJobs.$inferInsert;
