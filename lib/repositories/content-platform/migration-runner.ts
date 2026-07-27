import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  nexusRepositoryBindings,
  repositoryItems,
  repositoryItemVersions,
  repositoryMigrationItems,
  repositoryMigrationRuns,
  type RepositoryMigrationCursor,
  type RepositoryMigrationItemRow,
  type RepositoryMigrationMetrics,
  type RepositoryMigrationRunRow,
  type RepositoryMigrationSourceKind,
} from "@/lib/db/schema";
import { sanitizeFileName } from "@/lib/aws/document-upload";
import {
  buildProcessingIdempotencyKey,
  CONTENT_PROCESSING_MAX_ATTEMPTS,
} from "./job-state";
import { registerCanonicalUpload } from "./ingestion-service";
import {
  buildMigrationContentEvidence,
  buildMigrationRollbackObjectKeys,
  isMigrationOwnedCanonicalVersion,
} from "./migration-reconciliation";
import { buildRepositorySourceObjectKey } from "./object-key";
import { reconcileMigrationEvidence } from "./migration-reconciliation";
import { fetchRepositoryUrlText } from "./url-snapshot";

const MIGRATION_BATCH_SIZE = 3;
const RECONCILIATION_BATCH_SIZE = 10;
const MAX_ASSISTANT_PDF_BYTES = 25 * 1024 * 1024;

export interface MigrationStoredObject {
  byteSize: number;
  contentType: string | null;
  sha256: string;
}

export interface RepositoryMigrationStorage {
  inspectAndCopyObject(input: {
    sourceKey: string;
    targetKey: string;
  }): Promise<MigrationStoredObject>;
  putObject(input: {
    targetKey: string;
    body: Uint8Array;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<MigrationStoredObject>;
  deleteObject(objectKey: string): Promise<void>;
}

export class UnrecoverableMigrationSourceError extends Error {
  readonly code = "MIGRATION_SOURCE_UNRECOVERABLE";

  constructor(message: string) {
    super(message);
    this.name = "UnrecoverableMigrationSourceError";
  }
}

interface RepositoryCandidate {
  sourceKind: "repository_item";
  sourceId: number;
  ownerId: number;
  repositoryId: number;
  itemId: number;
  currentVersionId: string | null;
  itemType: string;
  name: string;
  source: string;
  metadata: Record<string, unknown>;
  legacySegments: string[];
}

interface NexusDocumentCandidate {
  sourceKind: "nexus_document";
  sourceId: number;
  ownerId: number;
  conversationId: string | null;
  name: string;
  source: string;
  byteSize: number;
  contentType: string;
  metadata: Record<string, unknown>;
  legacySegments: string[];
}

interface AssistantPdfCandidate {
  sourceKind: "assistant_pdf_job";
  sourceId: number;
  ownerId: number;
  name: string;
  byteSize: number;
  contentType: string;
  bytes: Uint8Array;
  legacySegments: string[];
}

type MigrationCandidate =
  RepositoryCandidate | NexusDocumentCandidate | AssistantPdfCandidate;

interface ReservedMigration {
  migration: RepositoryMigrationItemRow;
  repositoryId: number;
  itemId: number;
  createdRepository: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveIntegerValue(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = Number(record[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function deterministicMigrationSourceId(
  sourceKind: RepositoryMigrationSourceKind,
  sourceId: number,
): string {
  const bytes = createHash("sha256")
    .update(`aistudio-content-migration:${sourceKind}:${sourceId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function assistantPdfInput(
  input: string,
  output: string | null,
): Pick<
  AssistantPdfCandidate,
  "name" | "byteSize" | "contentType" | "bytes" | "legacySegments"
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new UnrecoverableMigrationSourceError(
      "Assistant Architect job input is not valid JSON",
    );
  }
  const record = asRecord(parsed);
  const fileName = stringValue(record, "fileName");
  const fileData = stringValue(record, "fileData");
  const fileType = stringValue(record, "fileType");
  const declaredSize = positiveIntegerValue(record, "fileSize");
  if (!fileName || !fileData || fileType !== "application/pdf") {
    throw new UnrecoverableMigrationSourceError(
      "Assistant Architect job is missing a recoverable PDF payload",
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) {
    throw new UnrecoverableMigrationSourceError(
      "Assistant Architect PDF payload is not valid base64",
    );
  }
  const bytes = Buffer.from(fileData, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_ASSISTANT_PDF_BYTES ||
    (declaredSize !== null && declaredSize !== bytes.byteLength)
  ) {
    throw new UnrecoverableMigrationSourceError(
      "Assistant Architect PDF payload size is invalid",
    );
  }
  let legacySegments: string[] = [];
  if (output) {
    const outputRecord = asRecord(output);
    const markdown = stringValue(outputRecord, "markdown");
    if (markdown) legacySegments = [markdown];
  }
  return {
    name: fileName,
    byteSize: bytes.byteLength,
    contentType: fileType,
    bytes,
    legacySegments,
  };
}

async function loadNextCandidate(
  run: RepositoryMigrationRunRow,
  sourceKind: RepositoryMigrationSourceKind,
): Promise<MigrationCandidate | null> {
  const cursor = run.cursor[sourceKind] ?? 0;
  const maximumId = run.snapshot.maximumIds?.[sourceKind] ?? 0;
  if (cursor >= maximumId) return null;

  if (sourceKind === "repository_item") {
    const row = toPgRows<{
      id: number;
      owner_id: number;
      repository_id: number;
      type: string;
      name: string;
      source: string;
      metadata: Record<string, unknown> | string | null;
      legacy_segments: string[];
      current_version_id: string | null;
    }>(
      await executeQuery(
        (db) =>
          db.execute(sql`
            SELECT
              item.id,
              repository.owner_id,
              item.repository_id,
              item.current_version_id,
              item.type,
              item.name,
              item.source,
              item.metadata,
              ARRAY(
                SELECT chunk.content
                FROM repository_item_chunks chunk
                WHERE chunk.item_id = item.id
                  AND chunk.item_version_id IS NULL
                ORDER BY chunk.chunk_index, chunk.id
              ) AS legacy_segments
            FROM repository_items item
            JOIN knowledge_repositories repository
              ON repository.id = item.repository_id
            WHERE item.id > ${cursor}
              AND item.id <= ${maximumId}
              AND item.lifecycle_status = 'active'
              AND repository.lifecycle_status = 'active'
              AND item.type IN ('document', 'text', 'url')
              AND (
                item.current_version_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM repository_item_chunks legacy_chunk
                  WHERE legacy_chunk.item_id = item.id
                    AND legacy_chunk.item_version_id IS NULL
                )
              )
              AND (
                NOT EXISTS (
                  SELECT 1
                  FROM repository_migration_items migration
                  WHERE migration.source_kind = 'repository_item'
                    AND migration.source_id = item.id
                )
                OR EXISTS (
                  SELECT 1
                  FROM repository_migration_items migration
                  WHERE migration.source_kind = 'repository_item'
                    AND migration.source_id = item.id
                    AND migration.run_id = ${run.id}::uuid
                    AND migration.status IN (
                      'pending',
                      'migrating',
                      'failed',
                      'unrecoverable'
                    )
                )
              )
            ORDER BY item.id
            LIMIT 1
          `),
        "contentMigration.nextRepositoryItem",
      ),
    )[0];
    return row
      ? {
          sourceKind,
          sourceId: row.id,
          ownerId: row.owner_id,
          repositoryId: row.repository_id,
          itemId: row.id,
          currentVersionId: row.current_version_id,
          itemType: row.type,
          name: row.name,
          source: row.source,
          metadata: asRecord(row.metadata),
          legacySegments: row.legacy_segments ?? [],
        }
      : null;
  }

  if (sourceKind === "nexus_document") {
    const row = toPgRows<{
      id: number;
      user_id: number;
      conversation_id: string | null;
      name: string;
      url: string;
      size: number;
      type: string;
      metadata: Record<string, unknown> | string | null;
      legacy_segments: string[];
    }>(
      await executeQuery(
        (db) =>
          db.execute(sql`
            SELECT
              document.id,
              document.user_id,
              document.conversation_id,
              document.name,
              document.url,
              document.size,
              document.type,
              document.metadata,
              ARRAY(
                SELECT chunk.content
                FROM document_chunks chunk
                WHERE chunk.document_id = document.id
                ORDER BY chunk.chunk_index, chunk.id
              ) AS legacy_segments
            FROM documents document
            WHERE document.id > ${cursor}
              AND document.id <= ${maximumId}
            ORDER BY document.id
            LIMIT 1
          `),
        "contentMigration.nextNexusDocument",
      ),
    )[0];
    return row
      ? {
          sourceKind,
          sourceId: row.id,
          ownerId: row.user_id,
          conversationId: row.conversation_id,
          name: row.name,
          source: row.url,
          byteSize: row.size,
          contentType: row.type,
          metadata: asRecord(row.metadata),
          legacySegments: row.legacy_segments ?? [],
        }
      : null;
  }

  const row = toPgRows<{
    id: number;
    user_id: number;
    input: string;
    output: string | null;
  }>(
    await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT job.id, job.user_id, job.input, job.output
          FROM jobs job
          WHERE job.type = 'pdf-to-markdown'
            AND job.id > ${cursor}
            AND job.id <= ${maximumId}
          ORDER BY job.id
          LIMIT 1
        `),
      "contentMigration.nextAssistantPdf",
    ),
  )[0];
  if (!row) return null;
  const parsed = assistantPdfInput(row.input, row.output);
  return {
    sourceKind,
    sourceId: row.id,
    ownerId: row.user_id,
    ...parsed,
  };
}

function targetFileName(candidate: MigrationCandidate): string {
  if (candidate.sourceKind === "repository_item") {
    const metadataName = stringValue(candidate.metadata, "originalFileName");
    const fallbackExtension =
      candidate.itemType === "text" || candidate.itemType === "url"
        ? ".txt"
        : "";
    return sanitizeFileName(
      metadataName ?? `${candidate.name}${fallbackExtension}`,
    );
  }
  return sanitizeFileName(candidate.name);
}

async function getOrCreateMigrationRepository(
  tx: Parameters<Parameters<typeof executeTransaction>[0]>[0],
  candidate: NexusDocumentCandidate | AssistantPdfCandidate,
): Promise<{ repositoryId: number; created: boolean }> {
  const source =
    candidate.sourceKind === "nexus_document"
      ? "nexus_documents"
      : "assistant_pdf_jobs";
  const lockKey =
    candidate.sourceKind === "nexus_document" && candidate.conversationId
      ? `${source}:${candidate.ownerId}:${candidate.conversationId}`
      : `${source}:${candidate.ownerId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );

  if (candidate.sourceKind === "nexus_document" && candidate.conversationId) {
    const [binding] = await tx
      .select({ repositoryId: nexusRepositoryBindings.repositoryId })
      .from(nexusRepositoryBindings)
      .where(
        and(
          eq(nexusRepositoryBindings.ownerId, candidate.ownerId),
          eq(nexusRepositoryBindings.conversationId, candidate.conversationId),
        ),
      )
      .limit(1);
    if (binding) return { repositoryId: binding.repositoryId, created: false };
  } else {
    const existing = toPgRows<{ id: number }>(
      await tx.execute(sql`
        SELECT id
        FROM knowledge_repositories
        WHERE owner_id = ${candidate.ownerId}
          AND lifecycle_status = 'active'
          AND metadata->>'migrationSource' = ${source}
        ORDER BY id
        LIMIT 1
      `),
    )[0];
    if (existing) return { repositoryId: existing.id, created: false };
  }

  const [repository] = await tx
    .insert(knowledgeRepositories)
    .values({
      name:
        candidate.sourceKind === "nexus_document"
          ? "Migrated Nexus documents"
          : "Migrated Assistant Architect PDFs",
      description:
        candidate.sourceKind === "nexus_document"
          ? "Private canonical sources recovered from legacy Nexus document records."
          : "Canonical PDF sources recovered from Assistant Architect conversion jobs.",
      ownerId: candidate.ownerId,
      isPublic: false,
      repositoryKind: "durable",
      lifecycleStatus: "active",
      metadata: {
        hidden: candidate.sourceKind === "nexus_document",
        migrationSource: source,
        nexusManaged: candidate.sourceKind === "nexus_document",
      },
    })
    .returning({ id: knowledgeRepositories.id });
  if (!repository) throw new Error("Failed to create migration repository");

  if (candidate.sourceKind === "nexus_document" && candidate.conversationId) {
    await tx.insert(nexusRepositoryBindings).values({
      ownerId: candidate.ownerId,
      draftKey: deterministicMigrationSourceId(
        "nexus_document",
        candidate.sourceId,
      ),
      conversationId: candidate.conversationId,
      repositoryId: repository.id,
      boundAt: new Date(),
    });
  }
  return { repositoryId: repository.id, created: true };
}

async function reserveMigrationCandidate(
  run: RepositoryMigrationRunRow,
  candidate: MigrationCandidate,
): Promise<ReservedMigration | null> {
  return executeTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(repositoryMigrationItems)
      .where(
        and(
          eq(repositoryMigrationItems.sourceKind, candidate.sourceKind),
          eq(repositoryMigrationItems.sourceId, candidate.sourceId),
        ),
      )
      .limit(1)
      .for("update");
    if (existing?.status === "rolled_back") {
      await tx
        .delete(repositoryMigrationItems)
        .where(eq(repositoryMigrationItems.id, existing.id));
    }
    if (
      existing &&
      existing.status !== "rolled_back" &&
      !["pending", "migrating", "failed", "unrecoverable"].includes(
        existing.status,
      )
    ) {
      return null;
    }
    if (existing && existing.status !== "rolled_back") {
      await tx
        .update(repositoryMigrationItems)
        .set({
          runId: run.id,
          status: "migrating",
          attempts: existing.attempts + 1,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryMigrationItems.id, existing.id));
      if (!existing.canonicalRepositoryId || !existing.canonicalItemId) {
        throw new Error("Migration retry is missing its canonical target");
      }
      return {
        migration: {
          ...existing,
          runId: run.id,
          status: "migrating",
          attempts: existing.attempts + 1,
        },
        repositoryId: existing.canonicalRepositoryId,
        itemId: existing.canonicalItemId,
        createdRepository: existing.metadata.createdRepository === true,
      };
    }

    let repositoryId: number;
    let itemId: number;
    let createdRepository = false;
    if (candidate.sourceKind === "repository_item") {
      repositoryId = candidate.repositoryId;
      itemId = candidate.itemId;
    } else {
      const repository = await getOrCreateMigrationRepository(tx, candidate);
      repositoryId = repository.repositoryId;
      createdRepository = repository.created;
      const [item] = await tx
        .insert(repositoryItems)
        .values({
          repositoryId,
          type: "document",
          name: candidate.name,
          source:
            candidate.sourceKind === "nexus_document"
              ? candidate.source
              : `legacy-assistant-pdf-job:${candidate.sourceId}`,
          metadata: {
            migrationSourceKind: candidate.sourceKind,
            migrationSourceId: candidate.sourceId,
          },
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id });
      if (!item) throw new Error("Failed to create migration repository item");
      itemId = item.id;
    }

    const [migration] = await tx
      .insert(repositoryMigrationItems)
      .values({
        runId: run.id,
        originRunId: run.id,
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        ownerId: candidate.ownerId,
        legacyRepositoryId:
          candidate.sourceKind === "repository_item"
            ? candidate.repositoryId
            : null,
        canonicalRepositoryId: repositoryId,
        canonicalItemId: itemId,
        sourceObjectKey:
          candidate.sourceKind === "assistant_pdf_job"
            ? null
            : candidate.source,
        status: "migrating",
        attempts: 1,
        metadata: {
          originalFileName: targetFileName(candidate),
          declaredContentType:
            candidate.sourceKind === "repository_item"
              ? (stringValue(candidate.metadata, "contentType") ?? undefined)
              : candidate.contentType,
          legacyConversationId:
            candidate.sourceKind === "nexus_document"
              ? (candidate.conversationId ?? undefined)
              : undefined,
          createdRepository,
        },
      })
      .returning();
    if (!migration) throw new Error("Failed to reserve migration source");
    return { migration, repositoryId, itemId, createdRepository };
  }, "contentMigration.reserveCandidate");
}

function textCandidateBody(candidate: RepositoryCandidate): Uint8Array | null {
  if (candidate.itemType === "text") {
    const content =
      candidate.legacySegments.length > 0
        ? candidate.legacySegments.join("\n")
        : candidate.source;
    return content.trim() ? Buffer.from(content, "utf8") : null;
  }
  if (candidate.itemType === "url") {
    const content = candidate.legacySegments.join("\n").trim();
    return content ? Buffer.from(content, "utf8") : null;
  }
  return null;
}

async function migrateCandidate(
  run: RepositoryMigrationRunRow,
  candidate: MigrationCandidate,
  storage: RepositoryMigrationStorage,
): Promise<void> {
  const reserved = await reserveMigrationCandidate(run, candidate);
  if (!reserved) return;
  const fileName = targetFileName(candidate);
  const targetKey = buildRepositorySourceObjectKey(
    reserved.repositoryId,
    fileName,
    deterministicMigrationSourceId(candidate.sourceKind, candidate.sourceId),
  );

  try {
    const repositoryItemCandidate =
      candidate.sourceKind === "repository_item" ? candidate : null;
    const currentVersionId = repositoryItemCandidate?.currentVersionId;
    if (currentVersionId) {
      const [version] = await executeQuery(
        (db) =>
          db
            .select({
              id: repositoryItemVersions.id,
              metadata: repositoryItemVersions.metadata,
              objectKey: repositoryItemVersions.objectKey,
              sha256: repositoryItemVersions.sha256,
              sourceKind: repositoryItemVersions.sourceKind,
            })
            .from(repositoryItemVersions)
            .where(
              and(
                eq(repositoryItemVersions.id, currentVersionId),
                eq(
                  repositoryItemVersions.itemId,
                  repositoryItemCandidate.itemId,
                ),
              ),
            )
            .limit(1),
        "contentMigration.existingCanonicalVersion",
      );
      if (!version) {
        throw new UnrecoverableMigrationSourceError(
          "Repository item references a missing canonical version",
        );
      }
      const migrationOwnedVersion = isMigrationOwnedCanonicalVersion({
        sourceKind: version.sourceKind,
        objectKey: version.objectKey,
        metadata: version.metadata,
        expectedObjectKey: targetKey,
        expectedSourceKind: candidate.sourceKind,
        expectedSourceId: candidate.sourceId,
      });
      const sourceContent = buildMigrationContentEvidence(
        candidate.legacySegments,
      );
      await executeQuery(
        (db) =>
          db
            .update(repositoryMigrationItems)
            .set({
              canonicalVersionId: version.id,
              canonicalObjectKey: version.objectKey,
              sourceRecordCount: sourceContent.recordCount,
              sourceContentSha256: sourceContent.sha256,
              sourceObjectSha256: version.sha256,
              canonicalObjectSha256: version.sha256,
              status: "migrated",
              metadata: {
                ...reserved.migration.metadata,
                preexistingCanonicalVersion: !migrationOwnedVersion,
              },
              migratedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(repositoryMigrationItems.id, reserved.migration.id)),
        "contentMigration.registerExistingCanonicalVersion",
      );
      return;
    }

    let stored: MigrationStoredObject;
    let declaredContentType: string;
    let comparisonSegments = candidate.legacySegments;
    let textBody =
      candidate.sourceKind === "repository_item"
        ? textCandidateBody(candidate)
        : null;
    if (
      candidate.sourceKind === "repository_item" &&
      candidate.itemType === "url" &&
      !textBody
    ) {
      const snapshot = await fetchRepositoryUrlText(candidate.source);
      comparisonSegments = [snapshot];
      textBody = Buffer.from(snapshot, "utf8");
    }
    const sourceContent = buildMigrationContentEvidence(comparisonSegments);
    if (textBody) {
      declaredContentType = "text/plain";
      stored = await storage.putObject({
        targetKey,
        body: textBody,
        contentType: declaredContentType,
        metadata: {
          migrationSourceKind: candidate.sourceKind,
          migrationSourceId: candidate.sourceId.toString(),
        },
      });
    } else if (candidate.sourceKind === "assistant_pdf_job") {
      declaredContentType = candidate.contentType;
      stored = await storage.putObject({
        targetKey,
        body: candidate.bytes,
        contentType: declaredContentType,
        metadata: {
          migrationSourceKind: candidate.sourceKind,
          migrationSourceId: candidate.sourceId.toString(),
        },
      });
    } else {
      if (!candidate.source.trim() || candidate.source.includes("..")) {
        throw new UnrecoverableMigrationSourceError(
          "Legacy source object key is invalid",
        );
      }
      const metadata =
        candidate.sourceKind === "repository_item"
          ? candidate.metadata
          : candidate.metadata;
      declaredContentType =
        candidate.sourceKind === "repository_item"
          ? (stringValue(metadata, "contentType") ?? "application/octet-stream")
          : candidate.contentType || "application/octet-stream";
      stored = await storage.inspectAndCopyObject({
        sourceKey: candidate.source,
        targetKey,
      });
      declaredContentType = stored.contentType ?? declaredContentType;
    }

    const registration = await registerCanonicalUpload({
      itemId: reserved.itemId,
      userId: candidate.ownerId,
      objectKey: targetKey,
      originalFileName: fileName,
      declaredContentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      sourceKind: "migration",
      traceId: `migration:${run.id}`,
      metadata: {
        migrationRunId: run.id,
        migrationSourceKind: candidate.sourceKind,
        migrationSourceId: candidate.sourceId,
      },
    });
    await executeTransaction(async (tx) => {
      await tx
        .update(repositoryItems)
        .set({
          source: targetKey,
          processingStatus: "pending",
          processingError: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryItems.id, reserved.itemId));
      await tx
        .update(repositoryMigrationItems)
        .set({
          canonicalVersionId: registration.version.id,
          canonicalObjectKey: targetKey,
          sourceRecordCount: sourceContent.recordCount,
          sourceContentSha256: sourceContent.sha256,
          sourceObjectSha256: stored.sha256,
          canonicalObjectSha256: stored.sha256,
          status: "migrated",
          lastErrorCode: null,
          lastErrorMessage: null,
          migratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(repositoryMigrationItems.id, reserved.migration.id));
    }, "contentMigration.completeCandidate");
  } catch (error) {
    const unrecoverable = error instanceof UnrecoverableMigrationSourceError;
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationItems)
          .set({
            status: unrecoverable ? "unrecoverable" : "failed",
            lastErrorCode: unrecoverable
              ? error.code
              : "MIGRATION_SOURCE_FAILED",
            lastErrorMessage: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 4_000),
            updatedAt: new Date(),
          })
          .where(eq(repositoryMigrationItems.id, reserved.migration.id)),
      "contentMigration.failCandidate",
    );
  }
}

async function updateRunCursor(
  runId: string,
  sourceKind: RepositoryMigrationSourceKind,
  sourceId: number,
): Promise<RepositoryMigrationRunRow> {
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_migration_runs
        SET cursor = cursor || jsonb_build_object(
              ${sourceKind},
              GREATEST(
                COALESCE((cursor->>${sourceKind})::bigint, 0),
                ${sourceId}
              )
            ),
            updated_at = NOW()
        WHERE id = ${runId}::uuid
        RETURNING *
      `),
    "contentMigration.advanceCursor",
  );
  const updated = toPgRows<RepositoryMigrationRunRow>(rows)[0];
  if (!updated) throw new Error("Migration run no longer exists");
  return {
    ...updated,
    cursor:
      typeof updated.cursor === "string"
        ? (JSON.parse(updated.cursor) as RepositoryMigrationCursor)
        : updated.cursor,
    snapshot:
      typeof updated.snapshot === "string"
        ? JSON.parse(updated.snapshot)
        : updated.snapshot,
    metrics:
      typeof updated.metrics === "string"
        ? JSON.parse(updated.metrics)
        : updated.metrics,
    sourceKinds:
      typeof updated.sourceKinds === "string"
        ? JSON.parse(updated.sourceKinds)
        : updated.sourceKinds,
  };
}

async function metricsForRun(
  runId: string | null,
  useOriginRun = false,
): Promise<RepositoryMigrationMetrics> {
  const rows = toPgRows<{ status: string; count: number }>(
    await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT status, COUNT(*)::integer AS count
          FROM repository_migration_items
          ${
            runId
              ? sql`WHERE ${
                  useOriginRun
                    ? sql`origin_run_id = ${runId}::uuid`
                    : sql`run_id = ${runId}::uuid`
                }`
              : sql``
          }
          GROUP BY status
        `),
      "contentMigration.runMetrics",
    ),
  );
  const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
  return {
    discovered: Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    ),
    migrated:
      (counts.migrated ?? 0) + (counts.verified ?? 0) + (counts.mismatch ?? 0),
    verified: counts.verified ?? 0,
    mismatched: counts.mismatch ?? 0,
    failed: counts.failed ?? 0,
    unrecoverable: counts.unrecoverable ?? 0,
    rolledBack: counts.rolled_back ?? 0,
  };
}

async function finishBackfillRun(
  run: RepositoryMigrationRunRow,
): Promise<void> {
  const metrics = await metricsForRun(run.id, true);
  const recoveryDaysRow = toPgRows<{ value: string | null }>(
    await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT value
          FROM settings
          WHERE key = 'CONTENT_MIGRATION_RECOVERY_DAYS'
          LIMIT 1
        `),
      "contentMigration.recoveryDays",
    ),
  )[0];
  const parsedRecoveryDays = Number.parseInt(recoveryDaysRow?.value ?? "7", 10);
  const recoveryDays =
    Number.isInteger(parsedRecoveryDays) &&
    parsedRecoveryDays >= 1 &&
    parsedRecoveryDays <= 90
      ? parsedRecoveryDays
      : 7;
  const hasErrors =
    (metrics.failed ?? 0) > 0 || (metrics.unrecoverable ?? 0) > 0;
  await executeQuery(
    (db) =>
      db
        .update(repositoryMigrationRuns)
        .set({
          status: hasErrors ? "completed_with_errors" : "completed",
          metrics,
          recoveryWindowEndsAt: new Date(
            Date.now() + recoveryDays * 24 * 60 * 60 * 1_000,
          ),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(repositoryMigrationRuns.id, run.id)),
    "contentMigration.finishBackfill",
  );
}

async function processBackfillBatch(
  initialRun: RepositoryMigrationRunRow,
  storage: RepositoryMigrationStorage,
): Promise<void> {
  let run = initialRun;
  let processed = 0;
  for (const sourceKind of run.sourceKinds) {
    while (
      processed < MIGRATION_BATCH_SIZE &&
      (run.cursor[sourceKind] ?? 0) <
        (run.snapshot.maximumIds?.[sourceKind] ?? 0)
    ) {
      const candidate = await loadNextCandidate(run, sourceKind);
      if (!candidate) {
        run = await updateRunCursor(
          run.id,
          sourceKind,
          run.snapshot.maximumIds?.[sourceKind] ?? 0,
        );
        break;
      }
      await migrateCandidate(run, candidate, storage);
      run = await updateRunCursor(run.id, sourceKind, candidate.sourceId);
      processed += 1;
    }
    if (processed >= MIGRATION_BATCH_SIZE) break;
  }
  const complete = run.sourceKinds.every(
    (sourceKind) =>
      (run.cursor[sourceKind] ?? 0) >=
      (run.snapshot.maximumIds?.[sourceKind] ?? 0),
  );
  if (complete) await finishBackfillRun(run);
}

async function reconcileNextBatch(
  run: RepositoryMigrationRunRow,
): Promise<void> {
  const migrations = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryMigrationItems)
        .where(
          and(
            inArray(repositoryMigrationItems.status, ["migrated", "mismatch"]),
            sql`${repositoryMigrationItems.canonicalVersionId} IS NOT NULL`,
          ),
        )
        .orderBy(repositoryMigrationItems.updatedAt)
        .limit(RECONCILIATION_BATCH_SIZE),
    "contentMigration.reconciliationCandidates",
  );
  let pending = 0;
  for (const candidate of migrations) {
    const disposition = await executeTransaction(async (tx) => {
      // Serialize reconciliation with administrator approval/reprocess actions.
      // A stale worker observation must never overwrite a freshly approved
      // mismatch or mark a version verified after reprocessing reset it.
      const [migration] = await tx
        .select()
        .from(repositoryMigrationItems)
        .where(eq(repositoryMigrationItems.id, candidate.id))
        .limit(1)
        .for("update");
      if (
        !migration?.canonicalVersionId ||
        !["migrated", "mismatch"].includes(migration.status)
      ) {
        return "skipped" as const;
      }
      const evidence = toPgRows<{
        processing_status: string | null;
        object_sha256: string | null;
        canonical_segments: string[];
      }>(
        await tx.execute(sql`
          SELECT
            version.processing_status,
            version.sha256 AS object_sha256,
            ARRAY(
              SELECT chunk.content
              FROM repository_item_chunks chunk
              WHERE chunk.item_version_id = version.id
                AND chunk.segment_level = 'chunk'
              ORDER BY chunk.chunk_index, chunk.id
            ) AS canonical_segments
          FROM repository_item_versions version
          WHERE version.id = ${migration.canonicalVersionId}::uuid
          LIMIT 1
        `),
      )[0];
      if (
        evidence?.processing_status === "pending" ||
        evidence?.processing_status === "processing"
      ) {
        return "pending" as const;
      }
      const canonicalContent = buildMigrationContentEvidence(
        evidence?.canonical_segments ?? [],
      );
      const approvedMismatch =
        typeof migration.metadata.approvedMismatchAt === "string";
      const decision = reconcileMigrationEvidence({
        sourceObjectSha256: migration.sourceObjectSha256,
        canonicalObjectSha256: evidence?.object_sha256 ?? null,
        sourceContent: {
          recordCount: migration.sourceRecordCount ?? 0,
          sha256: migration.sourceContentSha256,
        },
        canonicalContent,
        processingStatus: evidence?.processing_status ?? null,
        approvedMismatch,
      });
      await tx
        .update(repositoryMigrationItems)
        .set({
          status: decision.status,
          canonicalRecordCount: canonicalContent.recordCount,
          canonicalContentSha256: canonicalContent.sha256,
          canonicalObjectSha256: evidence?.object_sha256 ?? null,
          lastErrorCode:
            decision.status === "mismatch"
              ? "MIGRATION_RECONCILIATION_MISMATCH"
              : null,
          lastErrorMessage:
            decision.status === "mismatch"
              ? decision.reasons.join("; ").slice(0, 4_000)
              : null,
          verifiedAt: decision.status === "verified" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryMigrationItems.id, migration.id));
      return decision.status;
    }, "contentMigration.reconcileCandidate");
    if (disposition === "pending") pending += 1;
  }
  const remaining =
    toPgRows<{ count: number }>(
      await executeQuery(
        (db) =>
          db.execute(sql`
          SELECT COUNT(*)::integer AS count
          FROM repository_migration_items
          WHERE status = 'migrated'
        `),
        "contentMigration.remainingReconciliation",
      ),
    )[0]?.count ?? 0;
  if (remaining === 0 && pending === 0) {
    const metrics = await metricsForRun(null);
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationRuns)
          .set({
            status:
              (metrics.mismatched ?? 0) > 0
                ? "completed_with_errors"
                : "completed",
            metrics,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(repositoryMigrationRuns.id, run.id)),
      "contentMigration.finishReconciliation",
    );
  }
}

async function rollbackMigrationItem(
  migration: RepositoryMigrationItemRow,
  storage: RepositoryMigrationStorage,
): Promise<"rolled_back" | "deferred"> {
  if (migration.metadata.preexistingCanonicalVersion === true) {
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationItems)
          .set({
            status: "rolled_back",
            rolledBackAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(repositoryMigrationItems.id, migration.id)),
      "contentMigration.rollbackPreexistingVersion",
    );
    return "rolled_back";
  }

  const preparedObjectKeys = Array.isArray(
    migration.metadata.rollbackObjectKeys,
  )
    ? migration.metadata.rollbackObjectKeys.filter(
        (objectKey): objectKey is string =>
          typeof objectKey === "string" && objectKey.length > 0,
      )
    : [];
  if (migration.metadata.rollbackPrepared === true) {
    if (preparedObjectKeys.length === 0) {
      throw new Error("Prepared rollback is missing its object cleanup plan");
    }
    try {
      for (const objectKey of preparedObjectKeys) {
        await storage.deleteObject(objectKey);
      }
    } catch (error) {
      await executeQuery(
        (db) =>
          db
            .update(repositoryMigrationItems)
            .set({
              lastErrorCode: "MIGRATION_ROLLBACK_OBJECT_DELETE_FAILED",
              lastErrorMessage: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 4_000),
              updatedAt: new Date(),
            })
            .where(eq(repositoryMigrationItems.id, migration.id)),
        "contentMigration.failPreparedRollbackCleanup",
      );
      throw error;
    }
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationItems)
          .set({
            status: "rolled_back",
            rolledBackAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(repositoryMigrationItems.id, migration.id)),
      "contentMigration.finishPreparedRollback",
    );
    return "rolled_back";
  }

  const activeJob =
    toPgRows<{ count: number }>(
      await executeQuery(
        (db) =>
          db.execute(sql`
          SELECT COUNT(*)::integer AS count
          FROM repository_processing_jobs
          WHERE item_version_id = ${migration.canonicalVersionId}::uuid
            AND (
              status = 'running'
              OR (
                metrics ? 'bdaInvocationArn'
                AND COALESCE(metrics->>'bdaInvocationState', 'active') = 'active'
              )
              OR (
                metrics ? 'textractJobId'
                AND status IN ('queued', 'running')
              )
            )
        `),
        "contentMigration.rollbackActiveJobs",
      ),
    )[0]?.count ?? 0;
  if (activeJob > 0) return "deferred";

  const artifactKeys = migration.canonicalVersionId
    ? toPgRows<{ object_key: string }>(
        await executeQuery(
          (db) =>
            db.execute(sql`
              SELECT object_key
              FROM repository_artifacts
              WHERE item_version_id = ${migration.canonicalVersionId}::uuid
                AND object_key IS NOT NULL
            `),
          "contentMigration.rollbackArtifacts",
        ),
      ).map((row) => row.object_key)
    : [];
  const rollbackObjectKeys = buildMigrationRollbackObjectKeys(
    artifactKeys,
    migration.canonicalObjectKey,
  );

  // Restore the database read path before deleting external objects. If an S3
  // deletion fails, the migration row retains the exact cleanup list and the
  // next rollback can finish it; a failed external side effect can therefore
  // leave only inaccessible orphan bytes, never a live row pointing at bytes
  // that were already deleted.
  await executeTransaction(async (tx) => {
    if (
      migration.sourceKind === "repository_item" &&
      migration.canonicalItemId
    ) {
      await tx
        .update(repositoryItems)
        .set({
          currentVersionId: null,
          source:
            migration.sourceObjectKey ??
            migration.canonicalObjectKey ??
            "rolled-back-migration-source",
          processingStatus: sql`CASE
            WHEN EXISTS (
              SELECT 1
              FROM repository_item_chunks legacy_chunk
              WHERE legacy_chunk.item_id = ${migration.canonicalItemId}
                AND legacy_chunk.item_version_id IS NULL
            ) THEN 'completed'
            ELSE 'pending'
          END`,
          processingError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(repositoryItems.id, migration.canonicalItemId),
            migration.canonicalVersionId
              ? eq(
                  repositoryItems.currentVersionId,
                  migration.canonicalVersionId,
                )
              : isNull(repositoryItems.currentVersionId),
          ),
        );
      if (migration.canonicalVersionId) {
        await tx
          .delete(repositoryItemVersions)
          .where(eq(repositoryItemVersions.id, migration.canonicalVersionId));
      }
    } else if (migration.canonicalItemId) {
      await tx
        .delete(repositoryItems)
        .where(eq(repositoryItems.id, migration.canonicalItemId));
    }
    if (migration.canonicalRepositoryId) {
      await tx.execute(sql`
        DELETE FROM knowledge_repositories repository
        WHERE repository.id = ${migration.canonicalRepositoryId}
          AND repository.metadata->>'migrationSource' IN (
            'nexus_documents',
            'assistant_pdf_jobs'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM repository_items item
            WHERE item.repository_id = repository.id
          )
      `);
    }
    await tx
      .update(repositoryMigrationItems)
      .set({
        status: "migrating",
        metadata: {
          ...migration.metadata,
          rollbackPrepared: true,
          rollbackObjectKeys,
        },
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(repositoryMigrationItems.id, migration.id));
  }, "contentMigration.rollbackItem");

  try {
    for (const objectKey of rollbackObjectKeys) {
      await storage.deleteObject(objectKey);
    }
  } catch (error) {
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationItems)
          .set({
            lastErrorCode: "MIGRATION_ROLLBACK_OBJECT_DELETE_FAILED",
            lastErrorMessage: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 4_000),
            updatedAt: new Date(),
          })
          .where(eq(repositoryMigrationItems.id, migration.id)),
      "contentMigration.failRollbackCleanup",
    );
    throw error;
  }
  await executeQuery(
    (db) =>
      db
        .update(repositoryMigrationItems)
        .set({
          status: "rolled_back",
          rolledBackAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryMigrationItems.id, migration.id)),
    "contentMigration.finishRollbackItem",
  );
  return "rolled_back";
}

async function processRollbackBatch(
  run: RepositoryMigrationRunRow,
  storage: RepositoryMigrationStorage,
): Promise<void> {
  const parentRunId = run.snapshot.parentRunId;
  if (!parentRunId) throw new Error("Rollback run is missing its parent run");
  const migrations = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryMigrationItems)
        .where(
          and(
            eq(repositoryMigrationItems.originRunId, parentRunId),
            inArray(repositoryMigrationItems.status, [
              "pending",
              "migrating",
              "migrated",
              "verified",
              "mismatch",
              "failed",
              "unrecoverable",
            ]),
          ),
        )
        .orderBy(
          repositoryMigrationItems.sourceKind,
          repositoryMigrationItems.sourceId,
        )
        .limit(MIGRATION_BATCH_SIZE),
    "contentMigration.rollbackCandidates",
  );
  let rolledBack = 0;
  for (const migration of migrations) {
    const result = await rollbackMigrationItem(migration, storage);
    if (result === "rolled_back") rolledBack += 1;
  }
  const remaining =
    toPgRows<{ count: number }>(
      await executeQuery(
        (db) =>
          db.execute(sql`
          SELECT COUNT(*)::integer AS count
          FROM repository_migration_items
          WHERE origin_run_id = ${parentRunId}::uuid
            AND status <> 'rolled_back'
        `),
        "contentMigration.rollbackRemaining",
      ),
    )[0]?.count ?? 0;
  if (remaining === 0) {
    const total =
      toPgRows<{ count: number }>(
        await executeQuery(
          (db) =>
            db.execute(sql`
            SELECT COUNT(*)::integer AS count
            FROM repository_migration_items
            WHERE origin_run_id = ${parentRunId}::uuid
              AND status = 'rolled_back'
          `),
          "contentMigration.rollbackTotal",
        ),
      )[0]?.count ?? rolledBack;
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationRuns)
          .set({
            status: "rolled_back",
            metrics: { rolledBack: total },
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(repositoryMigrationRuns.id, run.id)),
      "contentMigration.finishRollback",
    );
  }
}

async function claimActiveRun(): Promise<RepositoryMigrationRunRow | null> {
  return executeTransaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(repositoryMigrationRuns)
      .where(inArray(repositoryMigrationRuns.status, ["queued", "running"]))
      .orderBy(repositoryMigrationRuns.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!run) return null;
    if (run.status === "queued") {
      const [started] = await tx
        .update(repositoryMigrationRuns)
        .set({
          status: "running",
          startedAt: new Date(),
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryMigrationRuns.id, run.id))
        .returning();
      return started ?? run;
    }
    return run;
  }, "contentMigration.claimRun");
}

/**
 * Advance one bounded migration batch. EventBridge invokes this through the
 * canonical worker; durable cursors and unique source mappings make retries and
 * overlapping scheduled invocations idempotent.
 */
export async function processNextRepositoryMigrationBatch(
  storage: RepositoryMigrationStorage,
): Promise<{ runId: string | null; mode: string | null }> {
  // Hold a transaction-scoped advisory lock for the complete bounded batch.
  // Database writes still use the normal helpers/connections, but a second
  // scheduled invocation cannot advance the same cursor while this invocation
  // is doing S3 work. If the process dies, PostgreSQL releases the lock and the
  // next invocation resumes a durable `migrating` row at the same source id.
  return executeTransaction(async (lockTx) => {
    const [lock] = toPgRows<{ acquired: boolean }>(
      await lockTx.execute(sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('repository-content-migration-worker', 0)
        ) AS acquired
      `),
    );
    if (!lock?.acquired) return { runId: null, mode: null };

    const run = await claimActiveRun();
    if (!run) return { runId: null, mode: null };
    try {
      if (run.mode === "backfill") {
        await processBackfillBatch(run, storage);
      } else if (run.mode === "reconcile") {
        await reconcileNextBatch(run);
      } else if (run.mode === "rollback") {
        await processRollbackBatch(run, storage);
      }
      return { runId: run.id, mode: run.mode };
    } catch (error) {
      await executeQuery(
        (db) =>
          db
            .update(repositoryMigrationRuns)
            .set({
              status: "failed",
              errorMessage: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 4_000),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(repositoryMigrationRuns.id, run.id)),
        "contentMigration.failRun",
      );
      throw error;
    }
  }, "contentMigration.processBatchLock");
}

/**
 * Queue a new canonical inspect attempt for a mismatch without changing source
 * mappings or creating duplicate versions.
 */
export async function reprocessRepositoryMigrationItem(
  migrationItemId: string,
): Promise<void> {
  await executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    const [retirement] = toPgRows<{ finalized: boolean }>(
      await tx.execute(sql`
        SELECT (
          to_regclass('public.documents') IS NULL
          AND to_regclass('public.document_chunks') IS NULL
          AND EXISTS (
            SELECT 1
            FROM repository_legacy_retirement_events
          )
        ) AS finalized
      `),
    );
    if (retirement?.finalized) {
      throw new Error(
        "Legacy content retirement is finalized; migration controls are read-only",
      );
    }
    const [migration] = await tx
      .select()
      .from(repositoryMigrationItems)
      .where(eq(repositoryMigrationItems.id, migrationItemId))
      .limit(1)
      .for("update");
    if (!migration?.canonicalVersionId) {
      throw new Error("Migration item has no canonical version to reprocess");
    }
    const [version] = await tx
      .select({ id: repositoryItemVersions.id })
      .from(repositoryItemVersions)
      .where(eq(repositoryItemVersions.id, migration.canonicalVersionId))
      .limit(1);
    if (!version)
      throw new Error("Canonical migration version no longer exists");
    await tx.execute(sql`
      UPDATE repository_processing_jobs
      SET status = 'cancelled',
          last_error_code = 'SUPERSEDED_BY_MIGRATION_REPROCESS',
          last_error_message = 'Superseded by an administrator migration reprocess',
          lease_owner = NULL,
          lease_expires_at = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE item_version_id = ${version.id}::uuid
        AND status IN ('pending', 'queued', 'running')
    `);
    const idempotencyKey = buildProcessingIdempotencyKey(
      version.id,
      "inspect",
      `migration-reprocess-${Date.now()}`,
    );
    await tx.execute(sql`
      INSERT INTO repository_processing_jobs (
        item_version_id,
        stage,
        status,
        idempotency_key,
        attempt,
        max_attempts,
        available_at,
        trace_id
      )
      VALUES (
        ${version.id}::uuid,
        'inspect',
        'pending',
        ${idempotencyKey},
        0,
        ${CONTENT_PROCESSING_MAX_ATTEMPTS},
        NOW(),
        ${`migration-reprocess:${migration.id}`}
      )
    `);
    await tx
      .update(repositoryItemVersions)
      .set({
        storageStatus: "quarantined",
        inspectionStatus: "pending",
        inspectionDetails: {},
        processingStatus: "pending",
      })
      .where(eq(repositoryItemVersions.id, version.id));
    await tx
      .update(repositoryItems)
      .set({
        processingStatus: "pending",
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(repositoryItems.id, migration.canonicalItemId!));
    await tx
      .update(repositoryMigrationItems)
      .set({
        status: "migrated",
        canonicalRecordCount: null,
        canonicalContentSha256: null,
        verifiedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(repositoryMigrationItems.id, migration.id));
  }, "contentMigration.reprocessItem");
}
