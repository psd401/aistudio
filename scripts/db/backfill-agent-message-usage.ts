/**
 * Backfill agent_messages token usage from checkpointed OpenClaw transcripts.
 *
 * WHY
 * OpenClaw 2026.7.2-beta.5 moved per-session transcripts from JSONL files into a
 * per-agent SQLite database. The harness adapter kept reading the deleted JSONL
 * path, so from 2026-07-31 (dev) / 2026-08-01 (prod) every agent_messages row
 * recorded zero tokens. The turns were fine and the transcripts survive in the
 * S3-checkpointed workspaces, so the real numbers are recoverable.
 *
 * Dry-run (default — reads only, writes NOTHING):
 *   AGENT_WORKSPACE_BUCKET=psd-agents-dev-390844780692 \
 *   DB_CLUSTER_ARN=arn:aws:rds:us-east-1:...:cluster:aistudio-dev-cluster \
 *   DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:...:secret:DbSecret... \
 *   bun scripts/db/backfill-agent-message-usage.ts --since=2026-07-30
 *
 * Execute (requires BOTH flags):
 *   ... bun scripts/db/backfill-agent-message-usage.ts --since=2026-07-30 \
 *       --execute --confirmation=BACKFILL_AGENT_USAGE
 *
 * SAFETY PROPERTIES
 *   - Dry-run is the default. Writing needs --execute AND the exact
 *     confirmation token, so no single typo can mutate telemetry.
 *   - Every UPDATE re-asserts "all four token counters are still zero" in its
 *     WHERE clause, so the run is idempotent: a second run updates 0 rows, and
 *     a row that the fixed live capture has since populated is never clobbered.
 *   - It only ever fills zero rows. It cannot overwrite a real measurement.
 *   - Reconciliation is printed before any write: transcript totals vs planned
 *     totals vs unattributed model calls. A non-zero unattributed count means
 *     attribution dropped usage and the plan under-counts — investigate rather
 *     than execute.
 *
 * All decision logic lives in lib/agents/usage-backfill.ts and is unit-tested;
 * this file is I/O only.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ExecuteStatementCommand,
  RDSDataClient,
  type Field,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
// Path-validating fs facade: confines every write to the working directory and
// the OS temp roots, which is where this script's scratch files live.
import { validatedFs } from "../../lib/filesystem/validated-fs";
import {
  BACKFILL_CONFIRMATION,
  isBackfillCandidate,
  mergePlans,
  parseBackfillArguments,
  parseTranscriptRecord,
  planSessionBackfill,
  restrictPlanToRowsSince,
  segmentTurns,
  sessionIdFromTranscriptKey,
  type BackfillArguments,
  type BackfillPlan,
  type CandidateRow,
  type TranscriptRecord,
} from "../../lib/agents/usage-backfill";
import { scriptLogger as log } from "./script-logger";

const BUCKET = process.env.AGENT_WORKSPACE_BUCKET ?? "";
const CLUSTER_ARN = process.env.DB_CLUSTER_ARN ?? "";
const SECRET_ARN = process.env.DB_SECRET_ARN ?? "";
const DATABASE = process.env.DB_NAME ?? "aistudio";
const REGION = process.env.AWS_REGION ?? "us-east-1";

const TRANSCRIPT_KEY_SUFFIX = "agents/main/agent/openclaw-agent.sqlite";

const s3 = new S3Client({ region: REGION });
const rds = new RDSDataClient({ region: REGION });

/** Bind a value as text and let Postgres cast it — the RDS Data API has no
 * bigint parameter type, and ms epochs / bigint ids overflow int32. */
const text = (name: string, value: string | number): SqlParameter => ({
  name,
  value: { stringValue: String(value) },
});

const flag = (name: string, value: boolean): SqlParameter => ({
  name,
  value: { booleanValue: value },
});

/** Read a Field as a number, tolerating long vs text encodings. */
function fieldNumber(field: Field | undefined): number {
  if (!field) return 0;
  if (typeof field.longValue === "number") return field.longValue;
  if (typeof field.stringValue === "string") return Number(field.stringValue);
  if (typeof field.doubleValue === "number") return field.doubleValue;
  return 0;
}

function fieldString(field: Field | undefined): string {
  return field?.stringValue ?? "";
}

/** Read a nullable boolean, preserving the three-state semantics of
 * usage_capture_complete (true / false / unknown). */
function fieldNullableBoolean(field: Field | undefined): boolean | null {
  if (!field || field.isNull) return null;
  return typeof field.booleanValue === "boolean" ? field.booleanValue : null;
}

async function query(
  sql: string,
  parameters: SqlParameter[] = []
): Promise<Field[][]> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      sql,
      parameters,
    })
  );
  return result.records ?? [];
}

/** List every workspace prefix in the bucket (the top-level "directories"). */
async function listWorkspacePrefixes(): Promise<string[]> {
  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Delimiter: "/",
        ContinuationToken: token,
      })
    );
    for (const entry of page.CommonPrefixes ?? []) {
      const prefix = entry.Prefix?.replace(/\/$/, "");
      // Skip the checkpoint staging area — not a user workspace.
      if (prefix && !prefix.startsWith(".")) prefixes.push(prefix);
    }
    token = page.NextContinuationToken;
  } while (token);
  return prefixes;
}

/**
 * Download one workspace's transcript database, or null when it has none.
 *
 * The -wal sidecar is deliberately NOT fetched: a checkpointed database may
 * carry a stale WAL from an earlier upload, and pairing a current .sqlite with
 * an older -wal can make SQLite read a torn or rolled-back state. Reading the
 * main file alone means we may miss the most recent uncheckpointed turns, which
 * under-counts rather than corrupting — the right direction to fail.
 */
async function fetchTranscriptDatabase(
  prefix: string,
  directory: string
): Promise<string | null> {
  const key = `${prefix}/${TRANSCRIPT_KEY_SUFFIX}`;
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) return null;
    const path = join(directory, "openclaw-agent.sqlite");
    validatedFs.writeFileSync(path, bytes);
    return path;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
}

interface SessionTranscript {
  /** agent_messages.session_id this transcript belongs to. */
  sessionId: string;
  /** Earliest session-window start, bounding the first turn. */
  sessionStartMs: number;
  records: TranscriptRecord[];
}

/**
 * Read per-session transcripts out of a workspace database.
 *
 * session_windows maps the OpenClaw transcript session_id (a UUID) to the PSD
 * sessionKey `agent:main:<agent_messages.session_id>` — verified against a real
 * checkpointed database. A sessionKey can own SEVERAL windows (rollover,
 * compaction, fork), so every window's events are merged under one sessionId
 * before turn attribution; otherwise a mid-session rollover would silently drop
 * the pre-rollover model calls.
 */
function readSessionTranscripts(databasePath: string): SessionTranscript[] {
  // `immutable=1` is REQUIRED, not an optimization. The checkpointed file is in
  // WAL mode but arrives without its -wal/-shm sidecars, and a plain read-only
  // open of a WAL database needs to build the -shm — which read-only forbids, so
  // it fails with "unable to open database file". `immutable` tells SQLite to
  // skip WAL recovery and locking entirely.
  //
  // Safe HERE and only here: this is a static snapshot in a private temp
  // directory with no concurrent writer. The live adapter
  // (harness_adapter._sum_sqlite_transcript_usage) must NEVER use immutable —
  // it reads a database the runtime is actively writing, where skipping locking
  // would risk a torn read.
  const db = new Database(`file:${databasePath}?mode=ro&immutable=1`, {
    readonly: true,
  });
  try {
    const windows = db
      .query(
        "SELECT session_id, session_key, created_at FROM session_windows",
      )
      .all() as Array<{
        session_id: string;
        session_key: string;
        created_at: number;
      }>;

    const bySessionId = new Map<string, SessionTranscript>();
    const windowToSession = new Map<string, string>();
    for (const window of windows) {
      const sessionId = sessionIdFromTranscriptKey(window.session_key);
      if (!sessionId) continue;
      windowToSession.set(window.session_id, sessionId);
      const existing = bySessionId.get(sessionId);
      if (existing) {
        existing.sessionStartMs = Math.min(
          existing.sessionStartMs,
          window.created_at,
        );
      } else {
        bySessionId.set(sessionId, {
          sessionId,
          sessionStartMs: window.created_at,
          records: [],
        });
      }
    }

    const events = db
      .query(
        "SELECT session_id, event_json FROM transcript_events ORDER BY session_id, seq",
      )
      .all() as Array<{ session_id: string; event_json: string }>;

    for (const event of events) {
      const sessionId = windowToSession.get(event.session_id);
      if (!sessionId) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.event_json);
      } catch {
        // Corrupt row: skip it rather than abort the workspace. Its usage is
        // simply not recoverable, and the reconciliation report will show the
        // shortfall.
        continue;
      }
      const record = parseTranscriptRecord(parsed);
      if (record) bySessionId.get(sessionId)?.records.push(record);
    }

    return [...bySessionId.values()].filter((s) => s.records.length > 0);
  } finally {
    db.close();
  }
}

function toCandidateRow(row: Field[]): CandidateRow {
  return {
    id: fieldNumber(row[0]),
    sessionId: fieldString(row[1]),
    createdAtMs: fieldNumber(row[2]),
    inputTokens: fieldNumber(row[3]),
    outputTokens: fieldNumber(row[4]),
    cacheReadInputTokens: fieldNumber(row[5]),
    cacheWriteInputTokens: fieldNumber(row[6]),
    usageCaptureComplete: fieldNullableBoolean(row[7]),
  };
}

/** One chunk's SELECT. Split out so the caller stays a simple loop. */
async function loadCandidateChunk(
  sessionIds: readonly string[]
): Promise<CandidateRow[]> {
  const placeholders = sessionIds.map((_, i) => `:s${i}`).join(", ");
  const parameters = sessionIds.map((value, i) => text(`s${i}`, value));
  // NO date predicate here on purpose. --since must not remove rows before
  // pairing: dropping a session's earlier turns would shift every later segment
  // onto the wrong row. The filter is applied to the resulting UPDATES instead.
  //
  // `placeholders` is built from the chunk INDEX (:s0, :s1, ...), never from
  // session-id content, so this template carries no caller data. Every value is
  // a bound parameter.
  const sql =
    "SELECT id, session_id, " +
    "(EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ms, " +
    "input_tokens, output_tokens, cache_read_input_tokens, " +
    "cache_write_input_tokens, usage_capture_complete " +
    `FROM agent_messages WHERE session_id IN (${placeholders})` +
    " ORDER BY session_id, created_at";

  // EVERY row is returned, populated ones included. A populated row still
  // consumes a turn segment, so filtering here would shift each later segment
  // onto the wrong row and misprice the session (review finding). Only
  // planSessionBackfill decides which rows are writable.
  const rows = await query(sql, parameters);
  return rows.map(toCandidateRow);
}

/** Load ALL agent_messages rows for the given session ids. */
async function loadCandidateRows(
  sessionIds: readonly string[]
): Promise<Map<string, CandidateRow[]>> {
  const bySession = new Map<string, CandidateRow[]>();
  // Chunked so a workspace with many sessions cannot exceed the statement's
  // parameter limits.
  const CHUNK = 50;
  for (let index = 0; index < sessionIds.length; index += CHUNK) {
    const candidates = await loadCandidateChunk(
      sessionIds.slice(index, index + CHUNK)
    );
    for (const candidate of candidates) {
      const list = bySession.get(candidate.sessionId) ?? [];
      list.push(candidate);
      bySession.set(candidate.sessionId, list);
    }
  }
  return bySession;
}

/**
 * Apply one planned update.
 *
 * The WHERE clause re-asserts the all-zero precondition, which is what makes
 * the run idempotent and safe to interrupt: the guard is enforced by the
 * database at write time, not by the plan that was computed earlier.
 */
async function applyUpdate(update: BackfillPlan["updates"][number]): Promise<boolean> {
  const rows = await query(
    `UPDATE agent_messages SET
       input_tokens = (:input)::int,
       output_tokens = (:output)::int,
       cache_read_input_tokens = (:cache_read)::int,
       cache_write_input_tokens = (:cache_write)::int,
       usage_capture_complete = :complete
     WHERE id = (:id)::bigint
       AND input_tokens = 0
       AND output_tokens = 0
       AND cache_read_input_tokens = 0
       AND cache_write_input_tokens = 0
     RETURNING id`,
    [
      text("input", update.after.input),
      text("output", update.after.output),
      text("cache_read", update.after.cacheRead),
      text("cache_write", update.after.cacheWrite),
      flag("complete", update.after.usageCaptureComplete),
      text("id", update.id),
    ]
  );
  return rows.length > 0;
}

function requireEnvironment(): void {
  const missing = [
    ["AGENT_WORKSPACE_BUCKET", BUCKET],
    ["DB_CLUSTER_ARN", CLUSTER_ARN],
    ["DB_SECRET_ARN", SECRET_ARN],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    log.fail(
      `Missing required environment: ${missing.map(([name]) => name).join(", ")}`
    );
    process.exit(1);
  }
}

/** Plan one workspace prefix. Returns [] when it has no usable transcript. */
async function planWorkspace(
  prefix: string,
  sinceMs: number | null
): Promise<{ plans: BackfillPlan[]; hadTranscript: boolean }> {
  const directory = validatedFs.mkdtempSync(
    join(tmpdir(), "agent-usage-backfill-")
  );
  try {
    const databasePath = await fetchTranscriptDatabase(prefix, directory);
    if (!databasePath) return { plans: [], hadTranscript: false };

    const transcripts = readSessionTranscripts(databasePath);
    const rowsBySession = await loadCandidateRows(
      transcripts.map((t) => t.sessionId)
    );
    const plans: BackfillPlan[] = [];
    for (const transcript of transcripts) {
      const rows = rowsBySession.get(transcript.sessionId) ?? [];
      if (rows.length === 0) continue;
      // --since is applied AFTER pairing, never before: it selects which rows
      // may be written, and must not remove the rows that establish the
      // session's turn ordering.
      const plan = restrictPlanToRowsSince(
        planSessionBackfill(rows, transcript.records),
        sinceMs
      );
      if (plan.turnCountMismatches > 0) {
        // Name the session and both counts. The summary warning tells the
        // operator to investigate before executing, which is not actionable
        // without knowing WHICH session disagreed and by how much.
        log.warn("Turn-count mismatch — nothing attributed for this session", {
          session: transcript.sessionId,
          completedTurnsInTranscript: segmentTurns(transcript.records).length,
          agentMessagesRows: rows.length,
          zeroRows: rows.filter(isBackfillCandidate).length,
          transcriptRecords: transcript.records.length,
        });
      }
      plans.push(plan);
    }
    return { plans, hadTranscript: true };
  } finally {
    validatedFs.rmSync(directory, { recursive: true, force: true });
  }
}

function reportPlan(plan: BackfillPlan, workspacesWithTranscripts: number): void {
  log.section("Per-row plan (before -> after)");
  for (const update of plan.updates) {
    log.info(`row ${update.id}`, {
      session: update.sessionId,
      turn: update.turnIndex,
      calls: `${new Date(update.firstRecordMs).toISOString()} .. ${new Date(
        update.lastRecordMs
      ).toISOString()}`,
      modelCalls: update.modelCalls,
      before: `in=${update.before.input} out=${update.before.output} cr=${update.before.cacheRead} cw=${update.before.cacheWrite} complete=${update.before.usageCaptureComplete}`,
      after: `in=${update.after.input} out=${update.after.output} cr=${update.after.cacheRead} cw=${update.after.cacheWrite} complete=${update.after.usageCaptureComplete}`,
    });
  }

  log.section("Totals");
  log.info("Workspaces with a transcript database", {
    count: workspacesWithTranscripts,
  });
  log.info("Rows to update", { count: plan.updates.length });
  log.info("Rows with nothing recoverable", {
    count: plan.unmatchedRowIds.length,
    ids: plan.unmatchedRowIds.slice(0, 40),
  });
  log.info("Transcript totals (all model calls found)", {
    ...plan.transcriptTotals,
  });
  log.info("Planned totals (what would be written)", { ...plan.plannedTotals });
  if (plan.turnCountMismatches > 0) {
    log.warn(
      "Sessions where the transcript's completed-turn count did not match the " +
        "agent_messages row count — NOTHING was attributed for these, because " +
        "pairing the wrong segment to the wrong row would silently misprice " +
        "turns. Investigate before executing.",
      { sessions: plan.turnCountMismatches }
    );
  }
  if (plan.unattributedModelCalls > 0) {
    log.warn(
      "Model calls no paired turn claimed (an in-flight trailing turn, or a " +
        "skipped mismatched session) — the plan under-counts by this much.",
      { unattributedModelCalls: plan.unattributedModelCalls }
    );
  }
}

/**
 * Fail fast when migration 177 has not been applied.
 *
 * Without it the per-workspace query dies on a missing column, which would
 * otherwise surface as one opaque SQL error per workspace — up to a hundred
 * lines that never name the actual prerequisite.
 */
async function requireMigration177(): Promise<void> {
  const rows = await query(
    "SELECT 1 FROM information_schema.columns " +
      "WHERE table_name = 'agent_messages' " +
      "AND column_name = 'usage_capture_complete'"
  );
  if (rows.length === 0) {
    log.fail(
      "agent_messages.usage_capture_complete is missing — migration 177 has " +
        "not been applied to this database. Deploy it first; nothing was read " +
        "or written."
    );
    process.exit(1);
  }
}

/**
 * Abort unless the whole invocation was understood, BEFORE anything is read.
 *
 * Every unparsed argument is fatal. A mistyped `--since` that degraded to "no
 * filter" would widen the run from the outage window to ALL history — the
 * opposite of what the operator asked for — and `--execute` without the exact
 * token is the same mistake pointing the other way. Both are checked ahead of
 * the environment and migration probes so a malformed command never even
 * connects.
 */
function requireUsableArguments(args: BackfillArguments): void {
  const failures = [...args.errors];
  if (args.execute && !args.confirmed) {
    failures.push(
      `--execute requires --confirmation=${BACKFILL_CONFIRMATION}; nothing was changed.`
    );
  }
  if (failures.length === 0) return;
  for (const failure of failures) log.fail(failure);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseBackfillArguments(process.argv.slice(2));
  log.section("agent_messages usage backfill (JSONL -> SQLite transcript move)");
  requireUsableArguments(args);
  requireEnvironment();
  await requireMigration177();
  const willWrite = args.execute && args.confirmed;
  log.info("Target", { bucket: BUCKET, database: DATABASE });
  log.info("Mode", {
    execute: willWrite,
    dryRun: !willWrite,
    prefix: args.prefix ?? "(all)",
    since: args.sinceMs ? new Date(args.sinceMs).toISOString() : "(none)",
  });

  const prefixes = args.prefix ? [args.prefix] : await listWorkspacePrefixes();
  log.info("Workspaces to scan", { count: prefixes.length });

  const plans: BackfillPlan[] = [];
  let workspacesWithTranscripts = 0;

  for (const prefix of prefixes) {
    try {
      const result = await planWorkspace(prefix, args.sinceMs);
      plans.push(...result.plans);
      if (result.hadTranscript) workspacesWithTranscripts += 1;
    } catch (error) {
      // One unreadable workspace must not abandon the rest; surface it loudly.
      log.error("Workspace failed — skipped", {
        prefix,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const plan = mergePlans(plans);
  reportPlan(plan, workspacesWithTranscripts);

  if (!willWrite) {
    log.success(
      `Dry run complete. NOTHING was written. Re-run with --execute --confirmation=${BACKFILL_CONFIRMATION} to apply.`
    );
    return;
  }

  log.section("Applying");
  let applied = 0;
  let skipped = 0;
  for (const update of plan.updates) {
    if (await applyUpdate(update)) {
      applied += 1;
    } else {
      // The all-zero guard rejected it: already backfilled, or the fixed live
      // capture populated it between planning and writing. Both are correct
      // outcomes, not errors.
      skipped += 1;
    }
  }
  log.success(`Applied ${applied} row(s); ${skipped} skipped by the zero-guard.`);
}

main().catch((error) => {
  log.fail(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
