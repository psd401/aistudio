/**
 * Nexus conversation retention sweep — orchestration core (Issue #1330).
 *
 * Written against injected ports (no AWS SDK, no postgres import) so the
 * ordering invariants that make an irreversible hard delete safe can be tested
 * with fakes. index.ts supplies the real adapters.
 *
 * Two ordering rules matter most:
 *   1. `nexus_repository_bindings` cascades from `nexus_conversations`, so the
 *      conversation's ephemeral repository IDs MUST be resolved before the
 *      conversation row is deleted. After the cascade those rows are
 *      unreachable and the `knowledge_repositories` rows they point at would
 *      be orphaned forever.
 *   2. The guarded conversation-row DELETE is the FIRST destructive act. It is
 *      the atomic claim: until it succeeds, a user who clicks Keep, pins, or
 *      sends a new message loses nothing — not the row, not S3 storage, not a
 *      bound repository. Storage cleanup runs only after the claim.
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

  /**
   * Repository IDs bound to a conversation whose repository_kind is
   * 'ephemeral' — and ONLY those. Promoted (durable) and system repositories
   * stay bound to the conversation but are explicitly user-preserved data; the
   * sweep must never touch their storage or rows, so the adapter filters them
   * out at the SQL level. Resolve BEFORE deleting the conversation (the
   * binding rows cascade away).
   */
  getBoundRepositoryIds(conversationId: string): Promise<number[]>;

  /** Legacy `documents` rows whose conversation_id is this conversation. */
  getLegacyDocuments(conversationId: string): Promise<LegacyDocument[]>;

  /**
   * S3 object keys referenced by this conversation's message parts that fall
   * OUTSIDE the conversation-scoped prefixes (which are swept wholesale by
   * deleteConversationStorage). Legacy rows only.
   */
  getMessageObjectKeys(conversationId: string, ownerUserId: number): Promise<string[]>;

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

  /**
   * Claim repositories for destruction by deleting their
   * `knowledge_repositories` rows (cascades repository_items etc.), and return
   * the IDs actually deleted.
   *
   * MUST re-assert `repository_kind = 'ephemeral'` in its WHERE clause.
   * Filtering only at resolution time is not enough: a user can promote a
   * repository to 'durable' in the window between resolution and cleanup, and
   * a stale ID would otherwise take that user-preserved repository's storage
   * with it. Deleting the row first, guarded, makes the claim atomic — storage
   * is only touched for repositories this returns.
   */
  claimRepositoryRows(repositoryIds: number[]): Promise<number[]>;

  /** Delete `documents` rows by id. */
  deleteDocumentRows(documentIds: number[]): Promise<number>;

  /**
   * Delete the conversation row; cascades the nexus_* children.
   *
   * MUST re-assert the FULL eligibility predicate — Keep, pin AND the age
   * cutoff (CANDIDATE_WHERE_CLAUSE with `retentionDays`) — in the DELETE's own
   * WHERE clause, and return the number of rows actually deleted. Flags alone
   * are not enough: a user who sends a new message after the late re-check
   * bumps last_message_at, and only re-testing the age inside the DELETE
   * itself makes that save the conversation atomically. This is the claim for
   * the whole operation: a return of 0 means the user won the race and nothing
   * may be destroyed.
   */
  deleteConversationRow(conversationId: string, retentionDays: number): Promise<number>;
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
 * Claim the conversation with the guarded row DELETE, then clean up its S3
 * storage and out-of-cascade rows.
 *
 * The row DELETE comes FIRST among the destructive steps, and its WHERE
 * re-asserts the full eligibility predicate (Keep, pin, age). Until it
 * succeeds, nothing has been destroyed — so a user who clicks Keep, pins, or
 * sends a new message at ANY point before the claim keeps the conversation
 * and every byte of its data. The alternative (storage first, gate second)
 * honoured the flag on the row but had already destroyed bound repository
 * objects when the user won the race.
 *
 * After the claim, cleanup failure policy is asymmetric on purpose:
 *   - Individual document / message-part / conversation-prefix deletions are
 *     best-effort (log-and-continue). The row is already gone; those objects
 *     have no surviving database reference and a transient S3 error must not
 *     resurrect half a conversation or stall the sweep.
 *   - A repository *prefix* deletion failing keeps that repository's
 *     knowledge_repositories row: row and objects stay consistent as a pair,
 *     ERROR-logged for the operator, and the ephemeral-repository lifecycle
 *     (expires_at / lifecycle_status) remains the eventual reclaim path.
 *     Repository rows are only deleted for repositories whose storage sweep
 *     succeeded.
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
  const messageObjectKeys = await ports.getMessageObjectKeys(conversationId, conversation.userId);

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

  // 2. The atomic claim, and the FIRST destructive act. The DELETE's own WHERE
  //    re-asserts the full eligibility predicate — Keep, pin AND the age
  //    cutoff — so a user who clicked Keep, pinned, or sent a new message in
  //    the window since step 1 makes it match nothing. 0 rows back means the
  //    user won, and at this point nothing whatsoever has been deleted: not
  //    the row, not S3 storage, not a repository. Winning the race is free.
  if ((await ports.deleteConversationRow(conversationId, retentionDays)) === 0) {
    log.info("keep_race_detected", {
      conversationId,
      message:
        "Conversation became Keep/pinned or received a new message mid-sweep; nothing was deleted.",
    });
    report.skippedReason = "keep_race_detected";
    return report;
  }

  // 3. Conversation-scoped prefixes — best effort. The row is gone, these
  //    objects have no database reference left, and a transient S3 error must
  //    not stall the sweep.
  try {
    report.storageObjectsDeleted += await ports.deleteConversationStorage(conversationId);
  } catch (error) {
    log.warn("conversation_storage_failed", {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    report.storageFailures++;
  }

  // 4. Legacy document objects + out-of-prefix message-part objects — best effort.
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

  // 5. Claim the repositories BEFORE touching their storage, the same
  //    claim-before-destroy shape as the conversation itself. The row delete
  //    re-asserts repository_kind = 'ephemeral', so a repository the user
  //    promoted to 'durable' since resolution matches nothing, is not returned,
  //    and keeps every byte. Resolution-time filtering alone could not cover
  //    that interleaving.
  const claimedRepositoryIds =
    repositoryIds.length > 0 ? await ports.claimRepositoryRows(repositoryIds) : [];
  report.repositoryRowsDeleted = claimedRepositoryIds.length;

  const promotedMidSweep = repositoryIds.filter((id) => !claimedRepositoryIds.includes(id));
  if (promotedMidSweep.length > 0) {
    log.info("repository_no_longer_ephemeral", {
      conversationId,
      repositoryIds: promotedMidSweep,
      message: "Repository was promoted or already removed mid-sweep; its storage was left intact.",
    });
  }

  // 6. Storage for the claimed repositories only — best effort. The rows are
  //    already gone, so a failure orphans objects rather than stranding a row,
  //    and it is ERROR-logged because unlike the single-key deletes above there
  //    is real bulk data behind it.
  for (const repositoryId of claimedRepositoryIds) {
    try {
      report.storageObjectsDeleted += await ports.deleteRepositoryStorage(repositoryId);
    } catch (error) {
      log.error("repository_storage_failed", {
        conversationId,
        repositoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      report.storageFailures++;
    }
  }

  // 7. Legacy documents rows, which would otherwise be left as SET NULL
  //    stragglers pointing at a conversation that no longer exists. The
  //    conversation row itself went first — it was step 2, the claim.
  //
  //    Counts come from what the database actually deleted rather than from the
  //    number of IDs we planned to delete: a partially-completed previous run
  //    can leave rows already gone, and reporting the planned count would
  //    overstate the sweep's effect in exactly the situation an operator is
  //    investigating.
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
