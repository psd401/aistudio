import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
  type DbTransaction,
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
import { normalizeCanonicalTextSource } from "./text-processing";
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
  createdAt: Date;
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

export interface VerifiedDuplicateNexusRecovery {
  sourceId: number;
  legacySegments: string[];
}

export interface VerifiedDuplicateNexusRecoveryCandidate
  extends VerifiedDuplicateNexusRecovery {
  sourceRecordCount: number;
  sourceContentSha256: string;
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
  bytes[6] = (bytes[6]! & 0x0F) | 0x50;
  bytes[8] = (bytes[8]! & 0x3F) | 0x80;
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

async function loadNextRepositoryCandidate(
  run: RepositoryMigrationRunRow,
  cursor: number,
  maximumId: number,
): Promise<RepositoryCandidate | null> {
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
            AND NOT (
              COALESCE(item.metadata, '{}'::jsonb) ? 'migrationSourceKind'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM repository_connector_sources connector_source
              WHERE connector_source.repository_item_id = item.id
                AND connector_source.status = 'unsupported'
            )
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
        sourceKind: "repository_item",
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

async function loadNextCandidate(
  run: RepositoryMigrationRunRow,
  sourceKind: RepositoryMigrationSourceKind,
): Promise<MigrationCandidate | null> {
  const cursor = run.cursor[sourceKind] ?? 0;
  const maximumId = run.snapshot.maximumIds?.[sourceKind] ?? 0;
  if (cursor >= maximumId) return null;

  if (sourceKind === "repository_item") {
    return loadNextRepositoryCandidate(run, cursor, maximumId);
  }

  if (sourceKind === "nexus_document") {
    const row = toPgRows<{
      id: number;
      user_id: number;
      conversation_id: string | null;
      created_at: Date;
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
              document.created_at,
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
          createdAt: row.created_at,
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
  tx: DbTransaction,
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

async function reuseMigrationReservation(
  tx: DbTransaction,
  existing: RepositoryMigrationItemRow | undefined,
  run: RepositoryMigrationRunRow,
): Promise<ReservedMigration | null | undefined> {
  if (!existing) return undefined;
  if (existing.status === "rolled_back") {
    await tx
      .delete(repositoryMigrationItems)
      .where(eq(repositoryMigrationItems.id, existing.id));
    return undefined;
  }
  if (
    !["pending", "migrating", "failed", "unrecoverable"].includes(
      existing.status,
    )
  ) {
    return null;
  }
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

async function createMigrationTarget(
  tx: DbTransaction,
  candidate: MigrationCandidate,
): Promise<{
  repositoryId: number;
  itemId: number;
  createdRepository: boolean;
}> {
  if (candidate.sourceKind === "repository_item") {
    return {
      repositoryId: candidate.repositoryId,
      itemId: candidate.itemId,
      createdRepository: false,
    };
  }
  const repository = await getOrCreateMigrationRepository(tx, candidate);
  const [item] = await tx
    .insert(repositoryItems)
    .values({
      repositoryId: repository.repositoryId,
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
  return {
    repositoryId: repository.repositoryId,
    itemId: item.id,
    createdRepository: repository.created,
  };
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
    const reused = await reuseMigrationReservation(tx, existing, run);
    if (reused !== undefined) return reused;
    const { repositoryId, itemId, createdRepository } =
      await createMigrationTarget(tx, candidate);

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

export function isMissingMigrationSourceObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const errorCode = [candidate.name, candidate.Code, candidate.code].find(
    (value): value is string => typeof value === "string",
  );
  return (
    ["NoSuchKey", "NotFound", "NoSuchBucket"].includes(errorCode ?? "") ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export function buildLegacyMigrationFallbackBody(
  legacySegments: string[],
): Uint8Array | null {
  const content = legacySegments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("\n");
  return content
    ? Buffer.from(
        normalizeCanonicalTextSource(Buffer.from(content, "utf8")),
        "utf8"
      )
    : null;
}

export function resolveVerifiedDuplicateNexusRecovery(
  candidates: VerifiedDuplicateNexusRecoveryCandidate[]
): VerifiedDuplicateNexusRecovery | null {
  if (candidates.length === 0) return null;
  const verified: Array<
    VerifiedDuplicateNexusRecoveryCandidate & { sha256: string }
  > = [];
  for (const candidate of candidates) {
    const evidence = buildMigrationContentEvidence(candidate.legacySegments);
    if (
      !evidence.sha256 ||
      evidence.recordCount !== candidate.sourceRecordCount ||
      evidence.sha256 !== candidate.sourceContentSha256.trim()
    ) {
      return null;
    }
    verified.push({ ...candidate, sha256: evidence.sha256 });
  }
  if (new Set(verified.map((entry) => entry.sha256)).size !== 1) {
    return null;
  }
  return {
    sourceId: verified[0]!.sourceId,
    legacySegments: verified[0]!.legacySegments,
  };
}

async function loadVerifiedDuplicateNexusRecovery(
  candidate: NexusDocumentCandidate
): Promise<VerifiedDuplicateNexusRecovery | null> {
  const rows = toPgRows<{
    source_id: number;
    source_record_count: number;
    source_content_sha256: string;
    legacy_segments: string[];
  }>(
    await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT
            document.id AS source_id,
            migration.source_record_count,
            migration.source_content_sha256,
            ARRAY(
              SELECT chunk.content
              FROM document_chunks chunk
              WHERE chunk.document_id = document.id
              ORDER BY chunk.chunk_index, chunk.id
            ) AS legacy_segments
          FROM documents document
          JOIN repository_migration_items migration
            ON migration.source_kind = 'nexus_document'
           AND migration.source_id = document.id
           AND migration.owner_id = document.user_id
          JOIN repository_item_versions version
            ON version.id = migration.canonical_version_id
           AND version.item_id = migration.canonical_item_id
          WHERE document.id <> ${candidate.sourceId}
            AND document.user_id = ${candidate.ownerId}
            AND document.conversation_id IS NOT DISTINCT FROM
                ${candidate.conversationId}::uuid
            AND document.created_at BETWEEN
                ${candidate.createdAt}::timestamptz - INTERVAL '10 minutes'
                AND ${candidate.createdAt}::timestamptz + INTERVAL '10 minutes'
            AND document.name = ${candidate.name}
            AND document.type = ${candidate.contentType}
            AND document.size = ${candidate.byteSize}
            AND COALESCE(document.metadata, '{}'::jsonb) =
                ${JSON.stringify(candidate.metadata)}::jsonb
            AND migration.status = 'verified'
            AND migration.source_record_count IS NOT NULL
            AND migration.source_content_sha256 IS NOT NULL
            AND migration.source_content_sha256 =
                migration.canonical_content_sha256
          ORDER BY document.id
        `),
      "contentMigration.verifiedDuplicateNexusRecovery"
    )
  );
  return resolveVerifiedDuplicateNexusRecovery(
    rows.map((row) => ({
      sourceId: row.source_id,
      sourceRecordCount: row.source_record_count,
      sourceContentSha256: row.source_content_sha256,
      legacySegments: row.legacy_segments ?? [],
    }))
  );
}

async function registerExistingCanonicalVersion(
  candidate: MigrationCandidate,
  reserved: ReservedMigration,
  targetKey: string,
): Promise<boolean> {
  if (
    candidate.sourceKind !== "repository_item" ||
    !candidate.currentVersionId
  ) {
    return false;
  }
  const currentVersionId = candidate.currentVersionId;
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
            eq(repositoryItemVersions.itemId, candidate.itemId),
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
  const sourceContent = buildMigrationContentEvidence(candidate.legacySegments);
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
  return true;
}

type StoredMigrationCandidate = {
  stored: MigrationStoredObject;
  declaredContentType: string;
  sourceObjectBytesAvailable: boolean;
  /**
   * Set only on the legacy-segment fallback path, where the stored body is
   * normalized through the canonical `text/plain` contract. Target evidence
   * must then be rebound to these exact stored bytes rather than the raw
   * legacy segments, or reconciliation reports a false mismatch.
   */
  comparisonSegments?: string[];
  /** Set only when the fallback body came from a verified duplicate source. */
  verifiedDuplicateSourceId?: number | null;
};

async function copyOrRecoverMigrationCandidate(
  candidate: Exclude<MigrationCandidate, AssistantPdfCandidate>,
  targetKey: string,
  storage: RepositoryMigrationStorage,
  metadata: Record<string, string>,
): Promise<StoredMigrationCandidate> {
  const fallbackContentType =
    candidate.sourceKind === "repository_item"
      ? (stringValue(candidate.metadata, "contentType") ??
        "application/octet-stream")
      : candidate.contentType || "application/octet-stream";
  try {
    const stored = await storage.inspectAndCopyObject({
      sourceKey: candidate.source,
      targetKey,
    });
    return {
      stored,
      declaredContentType: stored.contentType ?? fallbackContentType,
      sourceObjectBytesAvailable: true,
    };
  } catch (error) {
    if (!isMissingMigrationSourceObject(error)) throw error;
    let fallbackSegments = candidate.legacySegments;
    let verifiedDuplicateSourceId: number | null = null;
    if (
      candidate.sourceKind === "nexus_document" &&
      fallbackSegments.length === 0
    ) {
      const duplicate = await loadVerifiedDuplicateNexusRecovery(candidate);
      if (duplicate) {
        fallbackSegments = duplicate.legacySegments;
        verifiedDuplicateSourceId = duplicate.sourceId;
      }
    }
    const fallbackBody = buildLegacyMigrationFallbackBody(fallbackSegments);
    if (!fallbackBody) {
      throw new UnrecoverableMigrationSourceError(
        "Legacy source object and extracted content are unavailable",
      );
    }
    const declaredContentType = "text/plain";
    const stored = await storage.putObject({
      targetKey,
      body: fallbackBody,
      contentType: declaredContentType,
      metadata: {
        ...metadata,
        recoveredFromLegacySegments: "true",
        ...(verifiedDuplicateSourceId === null
          ? {}
          : {
              recoveredFromVerifiedDuplicateSourceId:
                verifiedDuplicateSourceId.toString(),
            }),
      },
    });
    return {
      stored,
      declaredContentType,
      sourceObjectBytesAvailable: false,
      comparisonSegments: [Buffer.from(fallbackBody).toString("utf8")],
      verifiedDuplicateSourceId,
    };
  }
}

async function storeMigrationCandidate(
  candidate: MigrationCandidate,
  targetKey: string,
  storage: RepositoryMigrationStorage,
): Promise<{
  stored: MigrationStoredObject;
  declaredContentType: string;
  sourceContent: ReturnType<typeof buildMigrationContentEvidence>;
  sourceObjectBytesAvailable: boolean;
  verifiedDuplicateSourceId: number | null;
}> {
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
  const metadata = {
    migrationSourceKind: candidate.sourceKind,
    migrationSourceId: candidate.sourceId.toString(),
  };
  if (textBody) {
    const declaredContentType = "text/plain";
    const stored = await storage.putObject({
      targetKey,
      body: textBody,
      contentType: declaredContentType,
      metadata,
    });
    return {
      stored,
      declaredContentType,
      sourceContent,
      sourceObjectBytesAvailable: true,
      verifiedDuplicateSourceId: null,
    };
  }
  if (candidate.sourceKind === "assistant_pdf_job") {
    const declaredContentType = candidate.contentType;
    const stored = await storage.putObject({
      targetKey,
      body: candidate.bytes,
      contentType: declaredContentType,
      metadata,
    });
    return {
      stored,
      declaredContentType,
      sourceContent,
      sourceObjectBytesAvailable: true,
      verifiedDuplicateSourceId: null,
    };
  }
  if (!candidate.source.trim() || candidate.source.includes("..")) {
    throw new UnrecoverableMigrationSourceError(
      "Legacy source object key is invalid",
    );
  }
  const { comparisonSegments: recoveredSegments, ...recovered } =
    await copyOrRecoverMigrationCandidate(
      candidate,
      targetKey,
      storage,
      metadata,
    );
  return {
    ...recovered,
    // On the fallback path the stored body is the canonically normalized text,
    // so bind evidence to those exact bytes instead of the raw segments.
    sourceContent: recoveredSegments
      ? buildMigrationContentEvidence(recoveredSegments)
      : sourceContent,
    verifiedDuplicateSourceId: recovered.verifiedDuplicateSourceId ?? null,
  };
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
    if (
      await registerExistingCanonicalVersion(candidate, reserved, targetKey)
    ) {
      return;
    }
    const {
      stored,
      declaredContentType,
      sourceContent,
      sourceObjectBytesAvailable,
      verifiedDuplicateSourceId,
    } = await storeMigrationCandidate(candidate, targetKey, storage);

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
          sourceObjectSha256: sourceObjectBytesAvailable
            ? stored.sha256
            : null,
          canonicalObjectSha256: stored.sha256,
          status: "migrated",
          metadata: {
            ...reserved.migration.metadata,
            ...(sourceObjectBytesAvailable
              ? {}
              : {
                  recoveredFromLegacySegments: true,
                  ...(verifiedDuplicateSourceId === null
                    ? {}
                    : {
                        recoveredFromVerifiedDuplicateSourceId:
                          verifiedDuplicateSourceId,
                      }),
                }),
          },
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

export async function updateRepositoryMigrationRunCursor(
  runId: string,
  sourceKind: RepositoryMigrationSourceKind,
  sourceId: number,
): Promise<RepositoryMigrationRunRow> {
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_migration_runs
        SET cursor = cursor || jsonb_build_object(
              ${sourceKind}::text,
              GREATEST(
                COALESCE((cursor->>${sourceKind}::text)::bigint, 0),
                ${sourceId}
              )
            ),
            updated_at = NOW()
        WHERE id = ${runId}::uuid
        RETURNING
          id,
          mode,
          status,
          requested_by AS "requestedBy",
          source_kinds AS "sourceKinds",
          cursor,
          snapshot,
          metrics,
          recovery_window_ends_at AS "recoveryWindowEndsAt",
          error_message AS "errorMessage",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
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

export async function getRepositoryMigrationRunMetrics(
  runId: string | null,
): Promise<RepositoryMigrationMetrics> {
  const rows = toPgRows<{ status: string; count: number }>(
    await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT status, COUNT(*)::integer AS count
          FROM repository_migration_items
          ${
            runId
              ? sql`WHERE run_id = ${runId}::uuid`
              : sql``
          }
          GROUP BY status
        `),
      "contentMigration.runMetrics",
    ),
  );
  const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
  const excluded = counts.excluded ?? 0;
  return {
    discovered:
      Object.values(counts).reduce((total, count) => total + count, 0) -
      excluded,
    migrated:
      (counts.migrated ?? 0) + (counts.verified ?? 0) + (counts.mismatch ?? 0),
    verified: counts.verified ?? 0,
    mismatched: counts.mismatch ?? 0,
    failed: counts.failed ?? 0,
    unrecoverable: counts.unrecoverable ?? 0,
    excluded,
    rolledBack: counts.rolled_back ?? 0,
  };
}

async function finishBackfillRun(
  run: RepositoryMigrationRunRow,
): Promise<void> {
  // A retry preserves origin_run_id for rollback ownership, but its result
  // belongs to the retry run that currently owns the item.
  const metrics = await getRepositoryMigrationRunMetrics(run.id);
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
        run = await updateRepositoryMigrationRunCursor(
          run.id,
          sourceKind,
          run.snapshot.maximumIds?.[sourceKind] ?? 0,
        );
        break;
      }
      await migrateCandidate(run, candidate, storage);
      run = await updateRepositoryMigrationRunCursor(
        run.id,
        sourceKind,
        candidate.sourceId,
      );
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

async function reconcileMigrationCandidate(
  tx: DbTransaction,
  candidate: RepositoryMigrationItemRow,
  runId: string,
): Promise<"skipped" | "pending" | "verified" | "mismatch"> {
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
    return "skipped";
  }
  const evidence = toPgRows<{
    processing_status: string | null;
    object_sha256: string | null;
    canonical_record_count: number;
    canonical_text_sha256: string | null;
  }>(
    await tx.execute(sql`
      SELECT
        version.processing_status,
        version.sha256 AS object_sha256,
        (
          SELECT COUNT(*)::integer
          FROM repository_item_chunks chunk
          WHERE chunk.item_version_id = version.id
        ) AS canonical_record_count,
        (
          SELECT COALESCE(
            artifact.sha256,
            CASE
              WHEN artifact.text_inline IS NOT NULL
              THEN encode(
                sha256(convert_to(artifact.text_inline, 'UTF8')),
                'hex'
              )
            END
          )
          FROM repository_artifacts artifact
          WHERE artifact.item_version_id = version.id
            AND artifact.kind = 'canonical_text'
          ORDER BY artifact.created_at DESC
          LIMIT 1
        ) AS canonical_text_sha256
      FROM repository_item_versions version
      WHERE version.id = ${migration.canonicalVersionId}::uuid
      LIMIT 1
    `),
  )[0] ?? {
    processing_status: null,
    object_sha256: null,
    canonical_record_count: 0,
    canonical_text_sha256: null,
  };
  if (["pending", "processing"].includes(evidence.processing_status ?? "")) {
    return "pending";
  }
  const canonicalContent = {
    recordCount: evidence.canonical_record_count,
    sha256: evidence.canonical_text_sha256,
  };
  const decision = reconcileMigrationEvidence({
    sourceObjectSha256: migration.sourceObjectSha256,
    canonicalObjectSha256: evidence.object_sha256,
    sourceContent: {
      recordCount: migration.sourceRecordCount ?? 0,
      sha256: migration.sourceContentSha256,
    },
    canonicalContent,
    processingStatus: evidence.processing_status,
    approvedMismatch:
      typeof migration.metadata.approvedMismatchAt === "string",
  });
  const mismatch = decision.status === "mismatch";
  await tx
    .update(repositoryMigrationItems)
    .set({
      status: decision.status,
      canonicalRecordCount: canonicalContent.recordCount,
      canonicalContentSha256: canonicalContent.sha256,
      canonicalObjectSha256: evidence.object_sha256,
      lastErrorCode: mismatch
        ? "MIGRATION_RECONCILIATION_MISMATCH"
        : null,
      lastErrorMessage: mismatch
        ? decision.reasons.join("; ").slice(0, 4_000)
        : null,
      verifiedAt: decision.status === "verified" ? new Date() : null,
      metadata: {
        ...migration.metadata,
        lastReconciledRunId: runId,
      },
      updatedAt: new Date(),
    })
    .where(eq(repositoryMigrationItems.id, migration.id));
  return decision.status;
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
            sql`COALESCE(
              ${repositoryMigrationItems.metadata} ->> 'lastReconciledRunId',
              ''
            ) <> ${run.id}`,
          ),
        )
        .orderBy(repositoryMigrationItems.updatedAt)
        .limit(RECONCILIATION_BATCH_SIZE),
    "contentMigration.reconciliationCandidates",
  );
  let pending = 0;
  for (const candidate of migrations) {
    const disposition = await executeTransaction(
      (tx) => reconcileMigrationCandidate(tx, candidate, run.id),
      "contentMigration.reconcileCandidate",
    );
    if (disposition === "pending") pending += 1;
  }
  const remaining =
    toPgRows<{ count: number }>(
      await executeQuery(
        (db) =>
          db.execute(sql`
          SELECT COUNT(*)::integer AS count
          FROM repository_migration_items
          WHERE status IN ('migrated', 'mismatch')
            AND canonical_version_id IS NOT NULL
            AND COALESCE(metadata ->> 'lastReconciledRunId', '') <> ${run.id}
        `),
        "contentMigration.remainingReconciliation",
      ),
    )[0]?.count ?? 0;
  if (remaining === 0 && pending === 0) {
    const metrics = await getRepositoryMigrationRunMetrics(null);
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

async function finishPreviouslyPreparedRollback(
  migration: RepositoryMigrationItemRow,
  storage: RepositoryMigrationStorage,
): Promise<boolean> {
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
    return true;
  }
  if (migration.metadata.rollbackPrepared !== true) return false;
  const preparedObjectKeys = Array.isArray(
    migration.metadata.rollbackObjectKeys,
  )
    ? migration.metadata.rollbackObjectKeys.filter(
        (objectKey): objectKey is string =>
          typeof objectKey === "string" && objectKey.length > 0,
      )
    : [];
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
  return true;
}

async function prepareRollbackDatabaseState(
  migration: RepositoryMigrationItemRow,
  rollbackObjectKeys: string[],
): Promise<void> {
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
}

async function rollbackMigrationItem(
  migration: RepositoryMigrationItemRow,
  storage: RepositoryMigrationStorage,
): Promise<"rolled_back" | "deferred"> {
  if (await finishPreviouslyPreparedRollback(migration, storage)) {
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

  await prepareRollbackDatabaseState(migration, rollbackObjectKeys);

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
            AND status NOT IN ('rolled_back', 'excluded')
        `),
        "contentMigration.rollbackRemaining",
      ),
    )[0]?.count ?? 0;
  if (remaining === 0) {
    const totals =
      toPgRows<{ rolled_back: number; excluded: number }>(
        await executeQuery(
          (db) =>
            db.execute(sql`
            SELECT
              COUNT(*) FILTER (
                WHERE status = 'rolled_back'
              )::integer AS rolled_back,
              COUNT(*) FILTER (
                WHERE status = 'excluded'
              )::integer AS excluded
            FROM repository_migration_items
            WHERE origin_run_id = ${parentRunId}::uuid
          `),
          "contentMigration.rollbackTotal",
        ),
      )[0];
    await executeQuery(
      (db) =>
        db
          .update(repositoryMigrationRuns)
          .set({
            status: "rolled_back",
            metrics: {
              rolledBack: totals?.rolled_back ?? rolledBack,
              excluded: totals?.excluded ?? 0,
            },
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
