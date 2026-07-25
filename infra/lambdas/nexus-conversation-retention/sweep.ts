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

  /**
   * Re-evaluate the FULL eligibility predicate for ONE conversation against
   * live state, as late as possible before destructive work begins.
   *
   * findCandidates snapshots up to `batchLimit` rows at the top of a run and
   * the loop then works through them sequentially, each doing several S3
   * round-trips — so minutes can pass between a conversation being selected and
   * being deleted. Without this re-read, a user who clicks Keep, pins, or
   * simply sends a new message inside that window would still lose the
   * conversation irreversibly, from a stale snapshot, defeating the exact flag
   * this feature is built around. Re-testing the age (not just the flags) is
   * what covers the "sent a new message" case.
   */
  isStillEligible(conversationId: string, retentionDays: number): Promise<boolean>;

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

  /**
   * Delete the conversation row; cascades the nexus_* children.
   *
   * MUST re-assert `is_saved = false AND is_pinned IS NOT TRUE` in its WHERE
   * clause and return the number of rows actually deleted. This is the atomic
   * gate for the whole operation: a return of 0 means the user won the race and
   * the conversation must survive.
   */
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
  /** Rows the database actually deleted, not the number of IDs resolved. */
  repositoryRowsDeleted: number;
  /** Rows the database actually deleted, not the number of IDs resolved. */
  documentRowsDeleted: number;
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
  /** Conversations abandoned by an unexpected error; isolated so the batch continues. */
  conversationsFailed: number;
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
    conversationsFailed: 0,
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
 *
 * The conversation row DELETE is deliberately positioned as the gate: it
 * re-asserts the Keep/pin predicate, and every other destructive step against
 * the conversation's own records runs only after it has succeeded.
 */
async function sweepConversation(
  ports: SweepPorts,
  log: SweepLogger,
  conversation: CandidateConversation,
  retentionDays: number,
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
    repositoryRowsDeleted: 0,
    documentRowsDeleted: 0,
    deleted: false,
  };

  if (dryRun) {
    return report;
  }

  // 1. Re-confirm eligibility against LIVE state. The candidate list is a
  //    snapshot taken at the top of the run; by the time this conversation's
  //    turn comes around the user may have clicked Keep or pinned it. Checked
  //    before a single byte is deleted.
  if (!(await ports.isStillEligible(conversationId, retentionDays))) {
    log.info("skipped_no_longer_eligible", { conversationId });
    report.skippedReason = "no_longer_eligible";
    return report;
  }

  // 2. Repository storage — fail-closed.
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

  // 3. The atomic gate. deleteConversationRow re-asserts the Keep/pin predicate
  //    in its WHERE clause, so if the user won the race in the window since
  //    step 1 this deletes nothing and returns 0. Everything genuinely
  //    destructive to the conversation's own records happens AFTER this point,
  //    which means losing the race costs the user nothing except the repository
  //    objects removed in step 2 — and their rows are deliberately left intact
  //    so the next run resolves them again from the still-present binding.
  if ((await ports.deleteConversationRow(conversationId)) === 0) {
    log.error("keep_race_detected", {
      conversationId,
      message:
        "Conversation became Keep/pinned mid-sweep; deletion aborted. Repository storage for this conversation may have been removed already.",
    });
    report.skippedReason = "keep_race_detected";
    return report;
  }

  // 4. Conversation-scoped prefixes — best effort. Unlike repository storage
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

  // 5. Legacy document objects + out-of-prefix message-part objects — best effort.
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

  // 6. Rows that would otherwise be orphaned (repositories) or left as
  //    SET NULL stragglers (documents). The conversation row itself is already
  //    gone — it was step 3, the gate.
  //
  //    Counts come from what the database actually deleted rather than from the
  //    number of IDs we planned to delete: a partially-completed previous run
  //    can leave rows already gone, and reporting the planned count would
  //    overstate the sweep's effect in exactly the situation an operator is
  //    investigating.
  if (repositoryIds.length > 0) {
    report.repositoryRowsDeleted = await ports.deleteRepositoryRows(repositoryIds);
  }
  if (report.documentIds.length > 0) {
    report.documentRowsDeleted = await ports.deleteDocumentRows(report.documentIds);
  }

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
    conversationsFailed: 0,
    conversations: [],
  };

  for (const conversation of candidates) {
    // Per-conversation isolation. Without this, a single unexpected database
    // error (connection drop, deadlock, an FK we did not anticipate) propagates
    // out of the loop and abandons every remaining candidate in the batch.
    // Because findCandidates is ordered oldest-first, the same conversation
    // would be selected first again on the next run, so one permanently-failing
    // row would stall the entire retention feature indefinitely.
    let report: SweepConversationReport;
    try {
      report = await sweepConversation(ports, log, conversation, config.retentionDays, dryRun);
    } catch (error) {
      log.error("conversation_sweep_failed", {
        conversationId: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      result.conversationsSkipped++;
      result.conversationsFailed++;
      continue;
    }

    result.conversations.push(report);
    result.storageObjectsDeleted += report.storageObjectsDeleted;

    if (report.deleted) {
      result.conversationsDeleted++;
      result.repositoryRowsDeleted += report.repositoryRowsDeleted;
      result.documentRowsDeleted += report.documentRowsDeleted;
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
