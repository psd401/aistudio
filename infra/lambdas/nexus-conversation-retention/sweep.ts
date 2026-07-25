/**
 * Nexus conversation retention sweep — orchestration core (Issue #1330).
 *
 * Written against injected ports (no AWS SDK, no postgres import) so the
 * ordering invariants that make an irreversible hard delete safe can be tested
 * with fakes. index.ts supplies the real adapters.
 *
 * The one ordering rule that matters most: `nexus_repository_bindings` cascades
 * from `nexus_conversations`, so the conversation's ephemeral repository IDs
 * MUST be resolved before the conversation row is deleted. After the cascade
 * those rows are unreachable and the `knowledge_repositories` rows they point
 * at would be orphaned forever.
 */

import {
  parseRetentionDays,
  retentionCutoff,
  type RetentionConfig,
} from "./retention-policy";

export interface SweepLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** A conversation selected for deletion. */
export interface CandidateConversation {
  id: string;
  userId: number;
  lastMessageAt: Date | null;
  isArchived: boolean | null;
}

/** A legacy `documents` row owned by a conversation. */
export interface LegacyDocument {
  id: number;
  /**
   * S3 object key derived from `documents.url`, or null when it could not be
   * derived. Current rows store a bare key, but rows written before the
   * mid-2025 change store a full presigned https URL (and older ones a
   * Supabase URL), so the adapter normalises and may fail to. A null key still
   * gets its database row deleted — leaving a dangling row pointing at a
   * conversation that no longer exists is worse than one unreferenced object.
   */
  objectKey: string | null;
}

export interface SweepPorts {
  /** Reads NEXUS_CONVERSATION_RETENTION_DAYS from the settings table. */
  getRetentionSetting(): Promise<string | null>;

  /**
   * Oldest-first candidate scan, capped at `limit`. Implements the SQL form of
   * the eligibility predicate (see retention-policy.CANDIDATE_WHERE_CLAUSE).
   */
  findCandidates(retentionDays: number, limit: number): Promise<CandidateConversation[]>;

  /** Ephemeral repository IDs bound to a conversation. Resolve BEFORE deleting it. */
  getBoundRepositoryIds(conversationId: string): Promise<number[]>;

  /** Legacy `documents` rows whose conversation_id is this conversation. */
  getLegacyDocuments(conversationId: string): Promise<LegacyDocument[]>;

  /**
   * S3 object keys referenced by this conversation's message parts that fall
   * OUTSIDE the conversation-scoped prefixes (which are swept wholesale by
   * deleteConversationStorage). Legacy rows only.
   */
  getMessageObjectKeys(conversationId: string): Promise<string[]>;

  /**
   * Delete every version + delete marker under the conversation-scoped
   * prefixes (`conversations/<id>/`, `v2/generated-images/<id>/`).
   *
   * Prefix-based rather than driven off message parts because the persist path
   * downgrades user image parts to `{ hasImage: true }` — the object exists in
   * S3 with no s3Key left in the row to find it by. A prefix sweep is the only
   * way those are ever reclaimed.
   */
  deleteConversationStorage(conversationId: string): Promise<number>;

  /** Delete every version + delete marker under `repositories/<id>/`. */
  deleteRepositoryStorage(repositoryId: number): Promise<number>;

  /** Delete every version + delete marker for one object key. */
  deleteObjectStorage(key: string): Promise<number>;

  /** Delete `knowledge_repositories` rows (cascades repository_items etc.). */
  deleteRepositoryRows(repositoryIds: number[]): Promise<number>;

  /** Delete `documents` rows by id. */
  deleteDocumentRows(documentIds: number[]): Promise<number>;

  /** Delete the conversation row; cascades the nexus_* children. */
  deleteConversationRow(conversationId: string): Promise<number>;
}

export interface SweepOptions {
  /** When true, report candidates and planned work without deleting anything. */
  dryRun?: boolean;
  /** Maximum conversations processed in one run. */
  batchLimit: number;
  /** Injected for deterministic tests. */
  now?: Date;
}

export interface SweepConversationReport {
  conversationId: string;
  repositoryIds: number[];
  documentIds: number[];
  messageObjectKeys: number;
  storageObjectsDeleted: number;
  storageFailures: number;
  deleted: boolean;
  skippedReason?: string;
}

export interface SweepResult {
  enabled: boolean;
  disabledReason?: string;
  dryRun: boolean;
  retentionDays: number | null;
  cutoffIso: string | null;
  candidates: number;
  conversationsDeleted: number;
  repositoryRowsDeleted: number;
  documentRowsDeleted: number;
  storageObjectsDeleted: number;
  conversationsSkipped: number;
  conversations: SweepConversationReport[];
}

function disabledResult(config: Extract<RetentionConfig, { enabled: false }>, dryRun: boolean): SweepResult {
  return {
    enabled: false,
    disabledReason: config.reason,
    dryRun,
    retentionDays: null,
    cutoffIso: null,
    candidates: 0,
    conversationsDeleted: 0,
    repositoryRowsDeleted: 0,
    documentRowsDeleted: 0,
    storageObjectsDeleted: 0,
    conversationsSkipped: 0,
    conversations: [],
  };
}

/**
 * Delete one conversation's S3 storage, then its out-of-cascade rows, then the
 * conversation itself.
 *
 * Failure policy is asymmetric on purpose:
 *   - Repository *prefix* deletion failing aborts this conversation entirely.
 *     Deleting the knowledge_repositories row anyway would strand its objects
 *     with nothing left in the database pointing at them. Nothing is deleted,
 *     the run continues with other conversations, and the next nightly run
 *     retries — visible in logs as a storage_failed event.
 *   - Individual document / message-part object deletions are best-effort
 *     (log-and-continue). Those are single keys, an already-missing object is
 *     the common case, and blocking a whole conversation on one of them would
 *     make the sweep trivially stallable.
 */
async function sweepConversation(
  ports: SweepPorts,
  log: SweepLogger,
  conversation: CandidateConversation,
  dryRun: boolean
): Promise<SweepConversationReport> {
  const conversationId = conversation.id;

  // Resolve everything that becomes unreachable after the cascade FIRST.
  const repositoryIds = await ports.getBoundRepositoryIds(conversationId);
  const documents = await ports.getLegacyDocuments(conversationId);
  const messageObjectKeys = await ports.getMessageObjectKeys(conversationId);

  const report: SweepConversationReport = {
    conversationId,
    repositoryIds,
    documentIds: documents.map((doc) => doc.id),
    messageObjectKeys: messageObjectKeys.length,
    storageObjectsDeleted: 0,
    storageFailures: 0,
    deleted: false,
  };

  if (dryRun) {
    return report;
  }

  // 1. Repository storage — fail-closed.
  for (const repositoryId of repositoryIds) {
    try {
      report.storageObjectsDeleted += await ports.deleteRepositoryStorage(repositoryId);
    } catch (error) {
      log.error("repository_storage_failed", {
        conversationId,
        repositoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      report.storageFailures++;
      report.skippedReason = "repository_storage_failed";
      return report;
    }
  }

  // 2. Conversation-scoped prefixes — best effort. Unlike repository storage
  //    these have no database row that would be orphaned by a failure, so a
  //    transient S3 error must not block the conversation's deletion forever.
  try {
    report.storageObjectsDeleted += await ports.deleteConversationStorage(conversationId);
  } catch (error) {
    log.warn("conversation_storage_failed", {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    report.storageFailures++;
  }

  // 3. Legacy document objects + out-of-prefix message-part objects — best effort.
  const legacyKeys = [
    ...documents.map((doc) => doc.objectKey).filter((key): key is string => key !== null),
    ...messageObjectKeys,
  ];
  for (const key of legacyKeys) {
    try {
      report.storageObjectsDeleted += await ports.deleteObjectStorage(key);
    } catch (error) {
      log.warn("object_storage_failed", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      report.storageFailures++;
    }
  }

  // 4. Rows that would otherwise be orphaned (repositories) or left as
  //    SET NULL stragglers (documents), then the conversation itself.
  if (repositoryIds.length > 0) {
    await ports.deleteRepositoryRows(repositoryIds);
  }
  if (report.documentIds.length > 0) {
    await ports.deleteDocumentRows(report.documentIds);
  }
  await ports.deleteConversationRow(conversationId);

  report.deleted = true;
  return report;
}

/**
 * Run one retention sweep.
 *
 * Exits as a no-op — without reading a single conversation — whenever the
 * retention setting is missing, empty, zero, negative or non-numeric.
 */
export async function runRetentionSweep(
  ports: SweepPorts,
  log: SweepLogger,
  options: SweepOptions
): Promise<SweepResult> {
  const dryRun = options.dryRun === true;

  const raw = await ports.getRetentionSetting();
  const config = parseRetentionDays(raw);

  if (!config.enabled) {
    log.info("sweep_disabled", { reason: config.reason });
    return disabledResult(config, dryRun);
  }

  const now = options.now ?? new Date();
  const cutoff = retentionCutoff(now, config.retentionDays);

  log.info("sweep_start", {
    retentionDays: config.retentionDays,
    cutoffIso: cutoff.toISOString(),
    batchLimit: options.batchLimit,
    dryRun,
  });

  const candidates = await ports.findCandidates(config.retentionDays, options.batchLimit);

  const result: SweepResult = {
    enabled: true,
    dryRun,
    retentionDays: config.retentionDays,
    cutoffIso: cutoff.toISOString(),
    candidates: candidates.length,
    conversationsDeleted: 0,
    repositoryRowsDeleted: 0,
    documentRowsDeleted: 0,
    storageObjectsDeleted: 0,
    conversationsSkipped: 0,
    conversations: [],
  };

  for (const conversation of candidates) {
    const report = await sweepConversation(ports, log, conversation, dryRun);
    result.conversations.push(report);
    result.storageObjectsDeleted += report.storageObjectsDeleted;

    if (report.deleted) {
      result.conversationsDeleted++;
      result.repositoryRowsDeleted += report.repositoryIds.length;
      result.documentRowsDeleted += report.documentIds.length;
    } else if (!dryRun) {
      result.conversationsSkipped++;
    }
  }

  log.info("sweep_complete", {
    retentionDays: result.retentionDays,
    cutoffIso: result.cutoffIso,
    candidates: result.candidates,
    conversationsDeleted: result.conversationsDeleted,
    repositoryRowsDeleted: result.repositoryRowsDeleted,
    documentRowsDeleted: result.documentRowsDeleted,
    storageObjectsDeleted: result.storageObjectsDeleted,
    conversationsSkipped: result.conversationsSkipped,
    dryRun,
  });

  return result;
}
