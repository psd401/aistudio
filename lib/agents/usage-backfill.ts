/**
 * Pure logic for backfilling agent_messages token usage from checkpointed
 * OpenClaw transcript databases.
 *
 * WHY A BACKFILL EXISTS
 * OpenClaw 2026.7.2-beta.5 moved per-session transcripts from JSONL files into a
 * per-agent SQLite database. The harness adapter kept reading the deleted JSONL
 * path, so from 2026-07-31 (dev) / 2026-08-01 (prod) every agent_messages row
 * recorded input_tokens = output_tokens = cache_read_input_tokens = 0. The turns
 * themselves were fine and the transcripts are intact in the S3-checkpointed
 * workspaces, so the real numbers are recoverable.
 *
 * All I/O lives in scripts/db/backfill-agent-message-usage.ts. Everything here
 * is a pure function over plain data so the risky parts — which transcript
 * records belong to which turn, and what the resulting UPDATE would be — are
 * unit-testable without S3, SQLite, or a database.
 *
 * TURN ATTRIBUTION IS THE WHOLE PROBLEM
 * agent_messages.session_id is a PSD sessionKey, and up to 8 rows (turns) share
 * one. The transcript is append-only across all of them, so summing a session's
 * events into one row would inflate it by the entire session history — the exact
 * mistake the live adapter's `since_ms` window exists to avoid.
 *
 * ROW TIMESTAMPS CANNOT BE USED AS TURN BOUNDARIES. The obvious model — turn k
 * covers (created_at[k-1], created_at[k]] — is WRONG, and a reviewer caught it:
 * the router releases the session lock in the `finally` of its invocation
 * wrapper (agent-router invokeWithSessionLockLease) but does not insert the
 * telemetry row until after the Google Chat response is sent
 * (recordOwnerResult). The next turn can therefore begin — and write transcript
 * records — BEFORE the previous turn's row is stamped, so the windows overlap
 * and calls get billed to the wrong row. Writing confidently wrong cost numbers
 * is worse than writing none.
 *
 * So we segment the TRANSCRIPT by its own turn structure instead, and use the
 * rows only for ORDER and count:
 *   1. Walk the session's records in append order, cutting a segment after each
 *      record whose stopReason is terminal ("stop"/"end_turn"). OpenClaw writes
 *      "toolUse" on every call that hands off to a tool, so a terminal reason is
 *      exactly the end-of-turn marker.
 *   2. Drop a trailing segment with no terminal reason — that is an in-flight or
 *      aborted turn, which has no row yet.
 *   3. Pair segment k with row k, rows ordered by created_at.
 *   4. If the counts DISAGREE, attribute nothing and report it. A count mismatch
 *      means our model of the session is wrong, and guessing would silently
 *      misprice turns.
 *
 * This needs EVERY row of the session, not just the zero ones — a populated row
 * still consumes a segment. Loading only candidates would shift every later
 * segment onto the wrong row (the second half of the same review finding).
 */

/** One assistant model call's token usage, as stored in a transcript record. */
export interface TranscriptUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** A transcript record reduced to the fields turn attribution needs. */
export interface TranscriptRecord {
  /** Epoch-ms timestamp of the model call. */
  timestampMs: number
  usage: TranscriptUsage
  /** OpenClaw's stopReason; only terminal values mean the turn finished. */
  stopReason: string | null
}

/** An agent_messages row that is a backfill candidate. */
export interface CandidateRow {
  id: number
  sessionId: string
  /** Epoch-ms of agent_messages.created_at. */
  createdAtMs: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  usageCaptureComplete: boolean | null
}

/** The proposed change for one row. */
export interface PlannedUpdate {
  id: number
  sessionId: string
  /** 0-based position of this turn within the session, for the dry-run report. */
  turnIndex: number
  /** The row's own created_at, so callers can apply a date filter AFTER pairing. */
  rowCreatedAtMs: number
  /** Timestamps of the paired segment's first and last model call. */
  firstRecordMs: number
  lastRecordMs: number
  before: TranscriptUsage & { usageCaptureComplete: boolean | null }
  after: TranscriptUsage & { usageCaptureComplete: boolean }
  modelCalls: number
}

export interface BackfillPlan {
  updates: PlannedUpdate[]
  /**
   * Rows we could not attribute any usage to. Reported rather than silently
   * skipped: a zero row with no transcript coverage is unrecoverable, and that
   * is a finding, not a no-op.
   */
  unmatchedRowIds: number[]
  /**
   * Model calls present in the transcript that no paired segment claimed —
   * an in-flight trailing turn, or every record of a session we refused to
   * attribute. Must be reported: a non-zero value means the plan under-counts.
   */
  unattributedModelCalls: number
  /**
   * Sessions where the number of completed turns in the transcript did not match
   * the number of `agent_messages` rows, so nothing was attributed. Non-zero
   * means real usage is recoverable in principle but our session model is wrong
   * — investigate before trusting the rest of the run.
   */
  turnCountMismatches: number
  /** Sum of every model call in the transcript, attributed or not. */
  transcriptTotals: TranscriptUsage
  /** Sum of what the plan would write. */
  plannedTotals: TranscriptUsage
}

/**
 * OpenClaw writes `toolUse` on every model call that hands off to a tool and
 * these only on the call that ends the turn. Mirrors
 * harness_adapter.TERMINAL_USAGE_STOP_REASONS — a novel value must never be
 * read as "the turn finished".
 */
export const TERMINAL_STOP_REASONS: readonly string[] = ["stop", "end_turn"]

const ZERO: TranscriptUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function addUsage(a: TranscriptUsage, b: TranscriptUsage): TranscriptUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

function isPositiveInt(value: unknown): value is number {
  // Excludes booleans, NaN, Infinity, and negatives. A transcript is
  // model-written JSON, so none of those are hypothetical.
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

/**
 * Extract a transcript record from a parsed `event_json` object.
 *
 * Returns null for anything that is not an assistant message carrying usage and
 * a usable timestamp — the same filter the live adapter applies. Never throws.
 */
export function parseTranscriptRecord(raw: unknown): TranscriptRecord | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  const message = record.message
  if (typeof message !== "object" || message === null) return null
  const msg = message as Record<string, unknown>
  if (msg.role !== "assistant") return null
  const usageRaw = msg.usage
  if (typeof usageRaw !== "object" || usageRaw === null) return null
  const usage = usageRaw as Record<string, unknown>

  const timestampMs = recordTimestampMs(record, msg)
  if (timestampMs === null) return null

  return {
    timestampMs,
    usage: {
      input: isPositiveInt(usage.input) ? usage.input : 0,
      output: isPositiveInt(usage.output) ? usage.output : 0,
      cacheRead: isPositiveInt(usage.cacheRead) ? usage.cacheRead : 0,
      cacheWrite: isPositiveInt(usage.cacheWrite) ? usage.cacheWrite : 0,
    },
    stopReason: typeof msg.stopReason === "string" ? msg.stopReason : null,
  }
}

/**
 * Epoch-ms of a transcript record. Prefers message.timestamp (already epoch-ms)
 * and falls back to the top-level ISO-8601 string, matching
 * harness_adapter._record_timestamp_ms.
 */
function recordTimestampMs(
  record: Record<string, unknown>,
  msg: Record<string, unknown>
): number | null {
  const messageTs = msg.timestamp
  if (typeof messageTs === "number" && Number.isFinite(messageTs)) {
    return Math.trunc(messageTs)
  }
  const topTs = record.timestamp
  if (typeof topTs === "string" && topTs.length > 0) {
    const parsed = Date.parse(topTs)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/**
 * Split a session's records into one segment per completed turn.
 *
 * Records must arrive in append order. A segment ends at each record whose
 * stopReason is terminal; OpenClaw writes "toolUse" on every call that hands off
 * to a tool, so a terminal reason is precisely the end-of-turn marker and a
 * novel/absent value can never be mistaken for one.
 *
 * A trailing run of records with no terminal reason is DROPPED — that is an
 * in-flight or aborted turn, which has no `agent_messages` row to receive it.
 * Returning it would shift the pairing and misprice every turn in the session.
 */
export function segmentTurns(
  records: readonly TranscriptRecord[]
): TranscriptRecord[][] {
  const segments: TranscriptRecord[][] = []
  let current: TranscriptRecord[] = []
  for (const record of records) {
    current.push(record)
    if (
      record.stopReason !== null &&
      TERMINAL_STOP_REASONS.includes(record.stopReason)
    ) {
      segments.push(current)
      current = []
    }
  }
  // `current` is deliberately discarded: no terminal reason means no finished
  // turn.
  return segments
}

function foldSegment(segment: readonly TranscriptRecord[]): TranscriptUsage {
  return segment.reduce<TranscriptUsage>(
    (totals, record) => addUsage(totals, record.usage),
    ZERO
  )
}

/**
 * Build the backfill plan for ONE session.
 *
 * `rows` must be EVERY `agent_messages` row for the session — including already
 * populated ones — ordered arbitrarily; they are sorted here. A populated row
 * still consumes a turn segment, so filtering to zero rows before this point
 * would shift every later segment onto the wrong row.
 */
export function planSessionBackfill(
  rows: readonly CandidateRow[],
  records: readonly TranscriptRecord[]
): BackfillPlan {
  const ordered = [...rows].sort((a, b) => a.createdAtMs - b.createdAtMs)
  const segments = segmentTurns(records)

  const transcriptTotals = records.reduce<TranscriptUsage>(
    (totals, record) => addUsage(totals, record.usage),
    ZERO
  )

  // A count mismatch means our model of this session is wrong — a turn we
  // cannot see, a row written by something else, an aborted turn that still
  // produced a row. Attribute NOTHING rather than pair the wrong segment with
  // the wrong row: silently mispriced turns are worse than a reported gap.
  if (segments.length !== ordered.length) {
    return {
      updates: [],
      unmatchedRowIds: ordered.filter(isBackfillCandidate).map((r) => r.id),
      unattributedModelCalls: records.length,
      turnCountMismatches: ordered.length === 0 && segments.length === 0 ? 0 : 1,
      transcriptTotals,
      plannedTotals: ZERO,
    }
  }

  const updates: PlannedUpdate[] = []
  const unmatchedRowIds: number[] = []
  let plannedTotals = ZERO
  let unattributed = records.length

  for (const [index, row] of ordered.entries()) {
    const segment = segments[index]
    unattributed -= segment.length

    // A populated row is left strictly alone; it only existed here to keep the
    // pairing aligned.
    if (!isBackfillCandidate(row)) continue

    const totals = foldSegment(segment)
    const recovered =
      totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    if (recovered === 0) {
      // The records covering this turn carry no usage themselves — what the
      // pre-2026-07-29 transcripts look like. UNRECOVERABLE, not a zero-value
      // update: writing zeros over zeros recovers nothing while reporting a
      // success.
      unmatchedRowIds.push(row.id)
      continue
    }

    plannedTotals = addUsage(plannedTotals, totals)
    updates.push({
      id: row.id,
      sessionId: row.sessionId,
      turnIndex: index,
      rowCreatedAtMs: row.createdAtMs,
      firstRecordMs: segment[0].timestampMs,
      lastRecordMs: segment[segment.length - 1].timestampMs,
      before: {
        input: row.inputTokens,
        output: row.outputTokens,
        cacheRead: row.cacheReadInputTokens,
        cacheWrite: row.cacheWriteInputTokens,
        usageCaptureComplete: row.usageCaptureComplete,
      },
      // Every segment ends on a terminal stopReason by construction, so a
      // paired turn is by definition completely captured.
      after: { ...totals, usageCaptureComplete: true },
      modelCalls: segment.length,
    })
  }

  return {
    updates,
    unmatchedRowIds,
    unattributedModelCalls: unattributed,
    turnCountMismatches: 0,
    transcriptTotals,
    plannedTotals,
  }
}

/**
 * Drop updates for rows older than `sinceMs`, recomputing `plannedTotals`.
 *
 * Applied AFTER pairing, never before. Filtering rows out of the query would
 * remove the anchors that establish a session's turn ordering and shift every
 * later segment onto the wrong row; restricting the resulting updates is safe
 * because pairing has already happened.
 */
export function restrictPlanToRowsSince(
  plan: BackfillPlan,
  sinceMs: number | null
): BackfillPlan {
  if (sinceMs === null) return plan
  const updates = plan.updates.filter((u) => u.rowCreatedAtMs >= sinceMs)
  return {
    ...plan,
    updates,
    plannedTotals: updates.reduce<TranscriptUsage>(
      (totals, update) => addUsage(totals, update.after),
      ZERO
    ),
  }
}

/** Merge per-session plans into one, summing every total. */
export function mergePlans(plans: readonly BackfillPlan[]): BackfillPlan {
  return plans.reduce<BackfillPlan>(
    (acc, plan) => ({
      updates: [...acc.updates, ...plan.updates],
      unmatchedRowIds: [...acc.unmatchedRowIds, ...plan.unmatchedRowIds],
      unattributedModelCalls:
        acc.unattributedModelCalls + plan.unattributedModelCalls,
      turnCountMismatches:
        acc.turnCountMismatches + plan.turnCountMismatches,
      transcriptTotals: addUsage(acc.transcriptTotals, plan.transcriptTotals),
      plannedTotals: addUsage(acc.plannedTotals, plan.plannedTotals),
    }),
    {
      updates: [],
      unmatchedRowIds: [],
      unattributedModelCalls: 0,
      turnCountMismatches: 0,
      transcriptTotals: ZERO,
      plannedTotals: ZERO,
    }
  )
}

/**
 * A row is only a candidate while every token counter is still zero.
 *
 * This is the idempotency predicate, and it is also asserted in the UPDATE's
 * WHERE clause so a re-run — or two concurrent runs — cannot double-write. Once
 * a row carries real numbers, whether from this backfill or from a fixed live
 * capture, the backfill must leave it alone.
 */
export function isBackfillCandidate(row: CandidateRow): boolean {
  return (
    row.inputTokens === 0 &&
    row.outputTokens === 0 &&
    row.cacheReadInputTokens === 0 &&
    row.cacheWriteInputTokens === 0
  )
}

/** Derive the PSD sessionKey stored in the transcript from an agent_messages row. */
export function transcriptSessionKey(
  sessionId: string,
  agentId = "main"
): string {
  // Verified against a checkpointed database: session_windows.session_key is
  // `agent:<agentId>:<agent_messages.session_id>`.
  return `agent:${agentId}:${sessionId}`
}

/** Recover the agent_messages.session_id from a transcript sessionKey. */
export function sessionIdFromTranscriptKey(
  sessionKey: string,
  agentId = "main"
): string | null {
  const prefix = `agent:${agentId}:`
  return sessionKey.startsWith(prefix)
    ? sessionKey.slice(prefix.length)
    : null
}

export const BACKFILL_CONFIRMATION = "BACKFILL_AGENT_USAGE"

export interface BackfillArguments {
  execute: boolean
  confirmed: boolean
  /** Restrict to one workspace prefix; omitted means every prefix in the bucket. */
  prefix: string | null
  /** Ignore agent_messages rows created before this epoch-ms, if given. */
  sinceMs: number | null
  /**
   * Fatal argument errors. Non-empty means the caller must abort — never
   * proceed with a partially understood invocation.
   */
  errors: string[]
}

/**
 * Parse argv. Dry-run is the default and requires no flags; writing needs BOTH
 * --execute and the exact confirmation token, so no single typo can mutate
 * production telemetry.
 *
 * A malformed `--since` is an ERROR, not an omission. Silently falling back to
 * "no filter" would widen a production run from the outage window to ALL
 * history — and the documented execute command relies on that filter to stay
 * narrow, so a mistyped date is exactly when the blast radius must not grow
 * (review finding).
 */
export function parseBackfillArguments(argv: readonly string[]): BackfillArguments {
  let execute = false
  let confirmed = false
  let prefix: string | null = null
  let sinceMs: number | null = null
  const errors: string[] = []

  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true
    } else if (arg.startsWith("--confirmation=")) {
      confirmed = arg.slice("--confirmation=".length) === BACKFILL_CONFIRMATION
    } else if (arg.startsWith("--prefix=")) {
      const value = arg.slice("--prefix=".length).trim()
      if (value.length === 0) {
        errors.push("--prefix was given but empty")
      } else {
        prefix = value
      }
    } else if (arg.startsWith("--since=")) {
      const raw = arg.slice("--since=".length).trim()
      const parsed = Date.parse(raw)
      if (raw.length === 0 || Number.isNaN(parsed)) {
        errors.push(
          `--since=${raw || "(empty)"} is not a valid date — refusing to run ` +
            "without the date filter it was meant to apply"
        )
      } else {
        sinceMs = parsed
      }
    } else {
      errors.push(`unrecognized argument: ${arg}`)
    }
  }

  return { execute, confirmed, prefix, sinceMs, errors }
}
