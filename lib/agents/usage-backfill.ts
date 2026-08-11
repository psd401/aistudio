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
 * We reconstruct each turn's window from the row timestamps instead, which is
 * sound because turns within a session are strictly serial: turn k's window is
 * (created_at of row k-1, created_at of row k]. The router inserts a row only
 * after the wrapper finishes the turn, so every model call of turn k is stamped
 * at or before row k's created_at; and turn k cannot begin until turn k-1 has
 * ended, so none of its calls precede row k-1's created_at. The first turn's
 * window opens at the session's own start.
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
  /** Inclusive-exclusive window actually used, for the dry-run report. */
  windowStartMs: number
  windowEndMs: number
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
   * Model calls present in the transcript that fell outside every turn window.
   * Must be reported: a non-zero value means attribution dropped real usage and
   * the plan under-counts.
   */
  unattributedModelCalls: number
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
 * Per-turn windows for one session's rows.
 *
 * Rows are sorted by created_at ascending. Turn k covers
 * (created_at[k-1], created_at[k]]; the first turn opens at `sessionStartMs`.
 * Windows are half-open at the start so a record on a boundary is billed to
 * exactly one turn — never both.
 */
export function assignTurnWindows(
  rows: readonly CandidateRow[],
  sessionStartMs: number
): Array<{ row: CandidateRow; startMs: number; endMs: number }> {
  const sorted = [...rows].sort((a, b) => a.createdAtMs - b.createdAtMs)
  return sorted.map((row, index) => ({
    row,
    startMs: index === 0 ? sessionStartMs : sorted[index - 1].createdAtMs,
    endMs: row.createdAtMs,
  }))
}

/**
 * Build the backfill plan for ONE session.
 *
 * `sessionStartMs` bounds the first turn. Records outside every window are
 * counted into `unattributedModelCalls` rather than forced into the nearest
 * turn: inventing attribution would corrupt per-turn cost, and the caller needs
 * to see that the reconciliation does not balance.
 */
export function planSessionBackfill(
  rows: readonly CandidateRow[],
  records: readonly TranscriptRecord[],
  sessionStartMs: number
): BackfillPlan {
  const windows = assignTurnWindows(rows, sessionStartMs)
  const updates: PlannedUpdate[] = []
  const unmatchedRowIds: number[] = []

  let transcriptTotals = ZERO
  for (const record of records) {
    transcriptTotals = addUsage(transcriptTotals, record.usage)
  }

  const attributed = new Set<TranscriptRecord>()
  let plannedTotals = ZERO

  for (const { row, startMs, endMs } of windows) {
    let totals = ZERO
    let modelCalls = 0
    let complete = false
    // Ascending timestamp so the LAST in-window record decides completeness,
    // matching the live adapter: an earlier terminal reason followed by more
    // model calls (a nudge leg) must not latch it true.
    const inWindow = records
      .filter((r) => r.timestampMs > startMs && r.timestampMs <= endMs)
      .sort((a, b) => a.timestampMs - b.timestampMs)
    for (const record of inWindow) {
      totals = addUsage(totals, record.usage)
      modelCalls += 1
      complete =
        record.stopReason !== null &&
        TERMINAL_STOP_REASONS.includes(record.stopReason)
      attributed.add(record)
    }

    const recovered =
      totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    if (modelCalls === 0 || recovered === 0) {
      // Either no transcript record covers this turn, or the records that do
      // carry zero usage themselves — which is what the pre-2026-07-29 rows
      // look like, when the transcript was not recording usage either. Both are
      // UNRECOVERABLE, not a zero-value update: writing zeros over zeros
      // recovers nothing while reporting a success, and would let the run claim
      // it fixed rows it did not.
      unmatchedRowIds.push(row.id)
      continue
    }

    plannedTotals = addUsage(plannedTotals, totals)
    updates.push({
      id: row.id,
      sessionId: row.sessionId,
      windowStartMs: startMs,
      windowEndMs: endMs,
      before: {
        input: row.inputTokens,
        output: row.outputTokens,
        cacheRead: row.cacheReadInputTokens,
        cacheWrite: row.cacheWriteInputTokens,
        usageCaptureComplete: row.usageCaptureComplete,
      },
      after: { ...totals, usageCaptureComplete: complete },
      modelCalls,
    })
  }

  return {
    updates,
    unmatchedRowIds,
    unattributedModelCalls: records.length - attributed.size,
    transcriptTotals,
    plannedTotals,
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
      transcriptTotals: addUsage(acc.transcriptTotals, plan.transcriptTotals),
      plannedTotals: addUsage(acc.plannedTotals, plan.plannedTotals),
    }),
    {
      updates: [],
      unmatchedRowIds: [],
      unattributedModelCalls: 0,
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
}

/**
 * Parse argv. Dry-run is the default and requires no flags; writing needs BOTH
 * --execute and the exact confirmation token, so no single typo can mutate
 * production telemetry.
 */
export function parseBackfillArguments(argv: readonly string[]): BackfillArguments {
  let execute = false
  let confirmed = false
  let prefix: string | null = null
  let sinceMs: number | null = null

  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true
    } else if (arg.startsWith("--confirmation=")) {
      confirmed = arg.slice("--confirmation=".length) === BACKFILL_CONFIRMATION
    } else if (arg.startsWith("--prefix=")) {
      const value = arg.slice("--prefix=".length).trim()
      prefix = value.length > 0 ? value : null
    } else if (arg.startsWith("--since=")) {
      const parsed = Date.parse(arg.slice("--since=".length))
      sinceMs = Number.isNaN(parsed) ? null : parsed
    }
  }

  return { execute, confirmed, prefix, sinceMs }
}
