import type { ExecuteStatementCommandInput } from '@aws-sdk/client-rds-data';
import { sanitizeEmailForLog } from './log-sanitization';
import { sanitizeDiagnostic } from './diagnostic-sanitization';

export interface CronTelemetryLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface CronFailureRecord {
  userEmail: string;
  sessionId: string;
  scheduleId: string;
  scheduleName?: string;
  errorMessage: string | null;
  severity?: 'error' | 'warn';
  context?: Record<string, unknown>;
  /** Immutable Scheduler occurrence identity for retry-safe failure upserts. */
  fireKey?: string;
}

export interface ScheduledRunRecord {
  /** Primary-key correlation for a promoted run; absent on ordinary cron rows. */
  scheduledRunId?: string;
  /** Immutable Scheduler occurrence identity for retry-safe run upserts. */
  fireKey?: string;
  userEmail: string;
  scheduleId: string;
  scheduleName?: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /**
   * `deferred` means the agent answered but the Chat post did NOT happen and
   * was handed to the durable retry queue. It is deliberately NOT `success`:
   * the owner has nothing yet. The router resolves it to `success` or `error`
   * when the queued delivery finishes (#1890), which is what the background
   * job path has always done (`recordCompletedJobResult`).
   */
  status: 'success' | 'error' | 'skipped' | 'promoted' | 'deferred';
  errorMessage?: string;
  failure?: {
    severity: 'error' | 'warn';
    context: Record<string, unknown>;
  };
}

export interface RunTelemetryConfig {
  databaseResourceArn: string;
  databaseSecretArn: string;
  databaseName: string;
}

export interface RunTelemetryRdsClient {
  execute(input: ExecuteStatementCommandInput): Promise<unknown>;
}

/**
 * A schedule's CURRENT failure streak, aggregated in one pass over the whole
 * streak rather than over a page of recent runs.
 *
 * Reading a fixed number of recent rows could not answer this safely. Once a
 * streak grew past the page, the run carrying the stamp fell off the end: a
 * schedule notified on failure 3 looked unnotified again by failure 15 and
 * sent a second message, then a third, which on a five-minute schedule is
 * roughly hourly. The suppression has to be evaluated against the entire
 * streak, so the database aggregates it.
 */
export interface ScheduleFailureStreak {
  /** Failed runs since the last success. 0 means there is no current streak. */
  consecutiveFailures: number;
  /** Whether ANY run in this streak carried the owner's message. */
  alreadyNotified: boolean;
  /** The newest failed run's recorded error text, for classification. */
  newestErrorMessage: string | null;
}

export interface RunTelemetry {
  /**
   * The schedule's current failure streak. Used to decide whether this owner
   * has already been told it is failing — the run rows ARE the suppression
   * state, so no extra store can drift from them.
   */
  failureStreak(
    params: { userEmail: string; scheduleId: string },
    log: CronTelemetryLogger,
  ): Promise<ScheduleFailureStreak | null>;
  /**
   * Stamp the run that carried the owner's failure message. Best-effort: a
   * stamp that cannot be written risks one repeat message, which is the right
   * way to fail for a feature whose whole purpose is not being silent.
   */
  markOwnerNotified(
    params: { userEmail: string; scheduleId: string; fireKey?: string },
    log: CronTelemetryLogger,
  ): Promise<void>;
  recordPreflightRun(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void>;
  recordRun(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void>;
  recordRunStrict(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void>;
  recordCronFailure(
    params: CronFailureRecord,
    log: CronTelemetryLogger,
  ): Promise<void>;
  recordCronFailureStrict(
    params: CronFailureRecord,
    log: CronTelemetryLogger,
  ): Promise<void>;
}

function nullableStringParameter(name: string, value?: string | null) {
  return value
    ? { name, value: { stringValue: value } }
    : { name, value: { isNull: true } };
}

function scheduledRunParameters(
  params: ScheduledRunRecord,
): NonNullable<ExecuteStatementCommandInput['parameters']> {
  const errorMessage = params.errorMessage
    ? sanitizeDiagnostic(params.errorMessage, 4000)
    : params.errorMessage;
  return [
    { name: 'user_id', value: { stringValue: params.userEmail } },
    { name: 'schedule_id', value: { stringValue: params.scheduleId } },
    nullableStringParameter('schedule_name', params.scheduleName),
    { name: 'session_id', value: { stringValue: params.sessionId } },
    { name: 'input_tokens', value: { longValue: params.inputTokens } },
    { name: 'output_tokens', value: { longValue: params.outputTokens } },
    { name: 'latency_ms', value: { longValue: params.latencyMs } },
    { name: 'status', value: { stringValue: params.status } },
    nullableStringParameter('error_message', errorMessage),
    nullableStringParameter('fire_key', params.fireKey),
  ];
}

function firstStringValue(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (
    result as {
      records?: Array<Array<{ stringValue?: unknown }>>;
    }
  ).records?.[0]?.[0]?.stringValue;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Statuses that decide a failure streak: a success ends it, a failure extends
 * it. Everything else — `skipped` (a coalesced fire that never ran) and
 * `promoted` (handed to the background job runner, whose own row carries the
 * outcome) — decides neither, and is excluded so a coalesced fire can neither
 * break a real streak nor start a false one.
 */
const STREAK_DECIDING_STATUSES = "('success', 'error', 'deferred')";
const FAILED_STATUSES = "('error', 'deferred')";

/**
 * How far back a streak is measured. Bounds the scan for a schedule that has
 * been failing for a year; the composite (user_id, schedule_id, created_at)
 * index from migration 188 keeps it an index range over one schedule's rows.
 *
 * The one behavioural consequence is deliberate: a schedule still failing
 * after this long has its stamp fall outside the window, so its owner is
 * reminded once per window rather than never again. Kept in step with
 * `FAILURE_STREAK_WINDOW_DAYS` in `lib/agent-schedules/run-reader.ts`.
 */
const FAILURE_STREAK_WINDOW_DAYS = 90;

function streakFromResult(result: unknown): ScheduleFailureStreak {
  if (!result || typeof result !== 'object') {
    throw new Error('Failure-streak query returned no result');
  }
  const row = (
    result as {
      records?: Array<
        Array<{
          longValue?: unknown;
          booleanValue?: unknown;
          stringValue?: unknown;
        }>
      >;
    }
  ).records?.[0];
  const failures = row?.[0]?.longValue;
  if (typeof failures !== 'number') {
    throw new TypeError('Failure-streak query returned no count');
  }
  const newestErrorMessage = row?.[2]?.stringValue;
  return {
    consecutiveFailures: failures,
    // Defaults to true on an unreadable value, which SUPPRESSES a message. A
    // value we cannot read must not be taken as "nobody has been told".
    alreadyNotified: failures > 0 && row?.[1]?.booleanValue !== false,
    newestErrorMessage:
      typeof newestErrorMessage === 'string' ? newestErrorMessage : null,
  };
}

/**
 * The streak aggregate, as one statement.
 *
 * Exported because this SQL is the load-bearing half of the owner notice and
 * substring assertions cannot prove it: `tests/smoke/agent-schedule-failure-
 * streak.smoke.ts` runs THIS text against real PostgreSQL. A mistake in the
 * `recent.id > bound.last_success_id` bound or the `BOOL_OR` placement would
 * reproduce the repeat-message bug with every unit test still green.
 *
 * Two statements' worth of work in one: the newest success bounds the streak,
 * and every failed run after it is counted, checked for the owner's stamp, and
 * asked for its error text. Mirrors `consecutiveFailuresBySchedule` in
 * `lib/agent-schedules/run-reader.ts`, which answers the same question for the
 * whole list at once.
 */
export const FAILURE_STREAK_SQL = `WITH recent AS (
            SELECT id, status, error_message, owner_notified_at
            FROM agent_scheduled_runs
            WHERE user_id = :user_id
              AND schedule_id = :schedule_id
              AND status IN ${STREAK_DECIDING_STATUSES}
              AND created_at
                  > NOW() - make_interval(
                      days => ${FAILURE_STREAK_WINDOW_DAYS}
                    )
          ),
          bound AS (
            SELECT MAX(CASE WHEN status = 'success' THEN id END)
                     AS last_success_id
            FROM recent
          )
          SELECT COUNT(*) AS failures,
                 COALESCE(
                   BOOL_OR(recent.owner_notified_at IS NOT NULL),
                   FALSE
                 ) AS already_notified,
                 (
                   ARRAY_AGG(recent.error_message ORDER BY recent.id DESC)
                 )[1] AS newest_error_message
          FROM recent, bound
          WHERE recent.status IN ${FAILED_STATUSES}
            AND (
              bound.last_success_id IS NULL
              OR recent.id > bound.last_success_id
            )`;

export async function readFailureStreak(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: { userEmail: string; scheduleId: string },
): Promise<ScheduleFailureStreak> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  const result = await rdsDataClient.execute({
    resourceArn: config.databaseResourceArn,
    secretArn: config.databaseSecretArn,
    database: config.databaseName,
    sql: FAILURE_STREAK_SQL,
    parameters: [
      { name: 'user_id', value: { stringValue: params.userEmail } },
      { name: 'schedule_id', value: { stringValue: params.scheduleId } },
    ],
  });
  return streakFromResult(result);
}

/**
 * Stamp the run that carried the owner's failure message.
 *
 * Called AFTER the Chat message is accepted, deliberately. Stamping first
 * would mean a message that failed to send still silences the schedule until
 * it succeeds again — trading the bug #1890 fixes for a quieter version of
 * itself. Stamping afterwards risks at most one repeat message if the stamp
 * fails, which is the right way round.
 *
 * `owner_notified_at IS NULL` keeps it idempotent, and the fire key targets
 * the exact occurrence. Without a fire key (a legacy invocation that carries
 * no occurrence identity) it falls back to this schedule's newest run, which
 * is the row the caller just wrote.
 */
/**
 * The stamp write, as one statement per locator.
 *
 * Exported alongside the read for the same reason: if this UPDATE matches no
 * row, the suppression never engages and the owner is messaged on every
 * subsequent failure — the bug class the read was fixed for, from the other
 * end. `tests/smoke/agent-schedule-failure-streak.smoke.ts` runs both of
 * these against real PostgreSQL.
 */
export function ownerNotifiedSql(options: { fireKey: boolean }): string {
  const locator = options.fireKey
    ? 'fire_key = :fire_key'
    : `id = (
         SELECT id
         FROM agent_scheduled_runs
         WHERE user_id = :user_id
           AND schedule_id = :schedule_id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )`;
  return `UPDATE agent_scheduled_runs
          SET owner_notified_at = NOW()
          WHERE ${locator}
            AND user_id = :user_id
            AND schedule_id = :schedule_id
            AND owner_notified_at IS NULL`;
}

export async function markOwnerNotified(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: { userEmail: string; scheduleId: string; fireKey?: string },
): Promise<void> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  await rdsDataClient.execute({
    resourceArn: config.databaseResourceArn,
    secretArn: config.databaseSecretArn,
    database: config.databaseName,
    sql: ownerNotifiedSql({ fireKey: Boolean(params.fireKey) }),
    parameters: [
      { name: 'user_id', value: { stringValue: params.userEmail } },
      { name: 'schedule_id', value: { stringValue: params.scheduleId } },
      ...(params.fireKey
        ? [{ name: 'fire_key', value: { stringValue: params.fireKey } }]
        : []),
    ],
  });
}

function updatedRecordCount(result: unknown): 0 | 1 {
  const updated = result && typeof result === 'object'
    ? (result as { numberOfRecordsUpdated?: unknown }).numberOfRecordsUpdated
    : undefined;
  if (updated !== 0 && updated !== 1) {
    throw new Error('Scheduled-run terminal update returned no update count');
  }
  return updated;
}

function promotedRunLocator(scheduledRunId?: string): string {
  return scheduledRunId
    ? 'id = CAST(:scheduled_run_id AS bigint)'
    : `id = (
        SELECT id
        FROM agent_scheduled_runs
        WHERE user_id = :user_id
          AND schedule_id = :schedule_id
          AND session_id = :session_id
          AND status = 'promoted'
        ORDER BY id DESC
        LIMIT 1
      )`;
}

function promotedRunParameters(
  params: ScheduledRunRecord,
): NonNullable<ExecuteStatementCommandInput['parameters']> {
  return [
    ...scheduledRunParameters(params),
    ...(params.scheduledRunId
      ? [{
        name: 'scheduled_run_id',
        value: { stringValue: params.scheduledRunId },
      }]
      : []),
  ];
}

/**
 * Strict scheduled-run writer for durability boundaries such as the ECS task
 * supervisor. The ordinary cron path wraps this best-effort so observability
 * does not replace the scheduled work; supervisors let failures propagate to
 * Lambda's async retry/DLQ path instead of leaving a run stuck as promoted.
 */
export async function writeScheduledRun(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: ScheduledRunRecord,
): Promise<void> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  await rdsDataClient.execute(
    {
      resourceArn: config.databaseResourceArn,
      secretArn: config.databaseSecretArn,
      database: config.databaseName,
      sql: `INSERT INTO agent_scheduled_runs
              (user_id, schedule_id, schedule_name, session_id,
               input_tokens, output_tokens, latency_ms, status, error_message,
               fire_key)
            VALUES
              (:user_id, :schedule_id, :schedule_name, :session_id,
               :input_tokens, :output_tokens, :latency_ms, :status,
               :error_message, :fire_key)
            ON CONFLICT (fire_key)
              WHERE fire_key IS NOT NULL
            DO UPDATE SET
              schedule_name = EXCLUDED.schedule_name,
              session_id = EXCLUDED.session_id,
              input_tokens = EXCLUDED.input_tokens,
              output_tokens = EXCLUDED.output_tokens,
              latency_ms = EXCLUDED.latency_ms,
              status = EXCLUDED.status,
              error_message = EXCLUDED.error_message
            WHERE NOT (
              EXCLUDED.status = 'deferred'
              AND agent_scheduled_runs.status IN ('success', 'error')
            )`,
      parameters: scheduledRunParameters(params),
    },
  );
}

/**
 * Insert preflight telemetry only when this Scheduler occurrence has no row.
 * A stale duplicate can fail authoritative lookup after the winning invocation
 * already promoted or completed; it must never rewrite that existing fire.
 * Return the durable status so failure mirroring is attempted only for the
 * occurrence state that actually remains visible.
 */
export async function writePreflightRun(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: ScheduledRunRecord,
): Promise<string> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  const result = await rdsDataClient.execute(
    {
      resourceArn: config.databaseResourceArn,
      secretArn: config.databaseSecretArn,
      database: config.databaseName,
      sql: `WITH inserted AS (
              INSERT INTO agent_scheduled_runs
                (user_id, schedule_id, schedule_name, session_id,
                 input_tokens, output_tokens, latency_ms, status,
                 error_message, fire_key)
              VALUES
                (:user_id, :schedule_id, :schedule_name, :session_id,
                 :input_tokens, :output_tokens, :latency_ms, :status,
                 :error_message, :fire_key)
              ON CONFLICT (fire_key)
                WHERE fire_key IS NOT NULL
              DO NOTHING
              RETURNING status
            )
            SELECT status FROM inserted
            UNION ALL
            SELECT existing.status
            FROM agent_scheduled_runs AS existing
            WHERE CAST(:fire_key AS text) IS NOT NULL
              AND existing.fire_key = CAST(:fire_key AS text)
              AND NOT EXISTS (SELECT 1 FROM inserted)
            LIMIT 1`,
      parameters: scheduledRunParameters(params),
    },
  );
  const storedStatus = firstStringValue(result);
  if (!storedStatus) {
    throw new Error('Preflight telemetry returned no durable fire status');
  }
  return storedStatus;
}

/**
 * Reserve the identity-column value before any promoted-row side effect. A
 * skipped sequence value is harmless; it lets the durable SQS resolver carry
 * the exact future row ID before that row exists.
 */
export async function reservePromotedRunId(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
): Promise<string> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  const result = await rdsDataClient.execute({
    resourceArn: config.databaseResourceArn,
    secretArn: config.databaseSecretArn,
    database: config.databaseName,
    sql: `SELECT CAST(
            nextval(
              pg_get_serial_sequence('agent_scheduled_runs', 'id')
            ) AS TEXT
          )`,
  });
  const scheduledRunId = firstStringValue(result);
  if (!scheduledRunId || !/^\d{1,20}$/.test(scheduledRunId)) {
    throw new Error('Promoted scheduled run reserved no valid ID');
  }
  return scheduledRunId;
}

/**
 * Strictly create the promoted row before RunTask and return its database ID.
 * That ID is the per-fire correlation key carried in JOB_PAYLOAD; the daily
 * AgentCore session ID is deliberately not unique enough for this purpose.
 */
export async function createPromotedRun(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: ScheduledRunRecord,
): Promise<string> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  if (params.status !== 'promoted') {
    throw new Error('Promoted scheduled run must use promoted status');
  }
  const usesReservedId = typeof params.scheduledRunId === 'string';
  const result = await rdsDataClient.execute(
    {
      resourceArn: config.databaseResourceArn,
      secretArn: config.databaseSecretArn,
      database: config.databaseName,
      sql: usesReservedId
        ? `INSERT INTO agent_scheduled_runs
              (id, user_id, schedule_id, schedule_name, session_id,
               input_tokens, output_tokens, latency_ms, status, error_message,
               fire_key)
            OVERRIDING SYSTEM VALUE
            VALUES
              (CAST(:scheduled_run_id AS bigint), :user_id, :schedule_id,
               :schedule_name, :session_id, :input_tokens, :output_tokens,
               :latency_ms, :status, :error_message, :fire_key)
            RETURNING CAST(id AS TEXT)`
        : `INSERT INTO agent_scheduled_runs
              (user_id, schedule_id, schedule_name, session_id,
               input_tokens, output_tokens, latency_ms, status, error_message,
               fire_key)
            VALUES
              (:user_id, :schedule_id, :schedule_name, :session_id,
               :input_tokens, :output_tokens, :latency_ms, :status,
               :error_message, :fire_key)
            RETURNING CAST(id AS TEXT)`,
      parameters: usesReservedId
        ? promotedRunParameters(params)
        : scheduledRunParameters(params),
    },
  );
  const scheduledRunId = firstStringValue(result);
  if (
    typeof scheduledRunId !== 'string'
    || !/^\d{1,20}$/.test(scheduledRunId)
  ) {
    throw new Error('Promoted scheduled run returned no valid ID');
  }
  if (
    params.scheduledRunId
    && scheduledRunId !== params.scheduledRunId
  ) {
    throw new Error('Promoted scheduled run returned the wrong reserved ID');
  }
  return scheduledRunId;
}

async function exactScheduledRunStatus(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: Pick<
    ScheduledRunRecord,
    'scheduledRunId' | 'userEmail' | 'scheduleId' | 'sessionId'
  > & { scheduledRunId: string },
): Promise<string | undefined> {
  const result = await rdsDataClient.execute(
    {
      resourceArn: config.databaseResourceArn,
      secretArn: config.databaseSecretArn,
      database: config.databaseName,
      sql: `SELECT status
            FROM agent_scheduled_runs
            WHERE id = CAST(:scheduled_run_id AS bigint)
              AND user_id = :user_id
              AND schedule_id = :schedule_id
              AND session_id = :session_id`,
      parameters: [
        { name: 'user_id', value: { stringValue: params.userEmail } },
        { name: 'schedule_id', value: { stringValue: params.scheduleId } },
        { name: 'session_id', value: { stringValue: params.sessionId } },
        {
          name: 'scheduled_run_id',
          value: { stringValue: params.scheduledRunId },
        },
      ],
    },
  );
  return firstStringValue(result);
}

export async function isPromotedRunPending(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: Pick<
    ScheduledRunRecord,
    'scheduledRunId' | 'userEmail' | 'scheduleId' | 'sessionId'
  > & { scheduledRunId: string },
): Promise<boolean> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  return (
    await exactScheduledRunStatus(config, rdsDataClient, params)
  ) === 'promoted';
}

async function hasExactTerminalRun(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: ScheduledRunRecord & { scheduledRunId: string },
): Promise<boolean> {
  const status = await exactScheduledRunStatus(
    config,
    rdsDataClient,
    params,
  );
  return status === 'success' || status === 'error';
}

/**
 * Strict, idempotent terminal repair for the ECS STOPPED supervisor. The job
 * runner normally updates this same promoted row before exiting. Updating by
 * its per-fire primary key means earlier terminal rows from the shared daily
 * AgentCore session cannot suppress a later task's startup-failure repair.
 */
export async function updatePromotedRunTerminal(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: ScheduledRunRecord,
): Promise<boolean> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Scheduled-run telemetry database is not configured');
  }
  const result = await rdsDataClient.execute(
    {
      resourceArn: config.databaseResourceArn,
      secretArn: config.databaseSecretArn,
      database: config.databaseName,
      sql: `UPDATE agent_scheduled_runs
            SET schedule_name = :schedule_name,
                fire_key = COALESCE(fire_key, :fire_key),
                input_tokens = input_tokens + :input_tokens,
                output_tokens = output_tokens + :output_tokens,
                latency_ms = latency_ms + :latency_ms,
                status = :status,
                error_message = :error_message
            WHERE ${promotedRunLocator(params.scheduledRunId)}
              AND user_id = :user_id
              AND schedule_id = :schedule_id
              AND session_id = :session_id
              AND status = 'promoted'`,
      parameters: promotedRunParameters(params),
    },
  );
  const updated = updatedRecordCount(result);
  if (updated === 1) return true;
  if (!params.scheduledRunId) return false;

  if (
    await hasExactTerminalRun(
      config,
      rdsDataClient,
      { ...params, scheduledRunId: params.scheduledRunId },
    )
  ) return false;
  throw new Error(
    `Promoted scheduled run ${params.scheduledRunId} has no terminal state`,
  );
}

/**
 * Strict failure-mirror writer for retryable durability boundaries such as the
 * ECS STOPPED-state supervisor.
 */
export async function writeCronFailure(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: CronFailureRecord,
): Promise<void> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Cron failure telemetry database is not configured');
  }
  const severity = params.severity ?? 'error';
  const truncatedError = params.errorMessage
    ? sanitizeDiagnostic(params.errorMessage, 4000)
    : null;
  const context = JSON.stringify({
    scheduleId: params.scheduleId,
    ...params.context,
  });
  await rdsDataClient.execute(
    {
      resourceArn: config.databaseResourceArn,
      secretArn: config.databaseSecretArn,
      database: config.databaseName,
      sql: `INSERT INTO agent_failures
              (source, severity, user_id, session_id, schedule_name,
               error_message, context, occurred_at, fire_key)
            VALUES
              ('cron', :severity, :user_id, :session_id, :schedule_name,
               :error_message, CAST(:context AS jsonb), NOW(), :fire_key)
            ON CONFLICT (source, fire_key)
              WHERE fire_key IS NOT NULL
            DO UPDATE SET
              severity = EXCLUDED.severity,
              user_id = EXCLUDED.user_id,
              session_id = EXCLUDED.session_id,
              schedule_name = EXCLUDED.schedule_name,
              error_message = EXCLUDED.error_message,
              context = EXCLUDED.context,
              -- Re-open a row that settleCronFireFailure already acknowledged.
              -- One fire_key can be delivered twice (Scheduler retries while a
              -- slow invocation is still holding the owner workspace lock), so
              -- the order success-then-real-failure is reachable: the retry
              -- succeeds and settles the row, then the original invocation
              -- fails for real and lands here. Without this reset the new error
              -- text is written into a row that stays acknowledged = TRUE, and
              -- every "unacknowledged failures" view silently loses it — the
              -- exact burial this settle path was added to prevent.
              acknowledged = FALSE,
              acknowledged_by = NULL,
              acknowledged_at = NULL`,
      parameters: [
        { name: 'severity', value: { stringValue: severity } },
        { name: 'user_id', value: { stringValue: params.userEmail } },
        { name: 'session_id', value: { stringValue: params.sessionId } },
        nullableStringParameter('schedule_name', params.scheduleName),
        nullableStringParameter('error_message', truncatedError),
        { name: 'context', value: { stringValue: context } },
        nullableStringParameter('fire_key', params.fireKey),
      ],
    },
  );
}

/**
 * Settle the HARNESS's failure row after a scheduled turn was promoted.
 *
 * Mirrors agent-router's `markPromotedTurnRecovered` — see the reasoning
 * there. The row this touches is not one this Lambda wrote: the harness
 * records it inside the container the moment the interactive clock runs out or
 * the transcript overflows, keyed on the AgentCore runtime session id, before
 * anything here knows the turn is about to be resumed on the job path.
 *
 * `sessionId` must therefore be the RUNTIME session (`runtimeSessionId`), not
 * the per-schedule conversation session — matching what the container wrote.
 *
 * Bounded to the newest unacknowledged row of this class in the last five
 * minutes so a runtime session id, which is stable per owner rather than per
 * turn, cannot settle an unrelated failure.
 */
export async function settlePromotedTurnFailure(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: { sessionId: string; errorClass: string },
): Promise<void> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Cron failure telemetry database is not configured');
  }
  await rdsDataClient.execute({
    resourceArn: config.databaseResourceArn,
    secretArn: config.databaseSecretArn,
    database: config.databaseName,
    sql: `UPDATE agent_failures
             SET severity = 'warn',
                 acknowledged = TRUE,
                 acknowledged_by = 'system:job-promotion',
                 acknowledged_at = NOW(),
                 context = COALESCE(context, '{}'::jsonb)
                           || '{"promoted":true}'::jsonb
           WHERE id = (
             SELECT id
               FROM agent_failures
              WHERE session_id = :session_id
                AND error_class = :error_class
                AND acknowledged = FALSE
                AND occurred_at > NOW() - INTERVAL '5 minutes'
              ORDER BY occurred_at DESC
              LIMIT 1
           )`,
    parameters: [
      { name: 'session_id', value: { stringValue: params.sessionId } },
      { name: 'error_class', value: { stringValue: params.errorClass } },
    ],
  });
}

/**
 * Settle the contention row a fire left behind once that same fire succeeds.
 *
 * Every schedule an owner has shares ONE workspace lock, so schedules on the
 * same cadence contend by design: `schedule-fire.ts` records
 * "Owner workspace is active for another schedule; retrying this fire" and the
 * retry then works. One owner with three schedules all firing every 15 minutes
 * produced ~192 of those warn rows a day, which buried the real failures they
 * sit next to in the operator feed.
 *
 * The failure insert already upserts on `(source, fire_key)`, so there is at
 * most one row per Scheduler occurrence: when that occurrence finally
 * succeeds, this acknowledges exactly that row. Contention that never resolves
 * writes a row that nothing settles, so it stays visible — which is the whole
 * point of recording it.
 *
 * Deliberately NOT bounded by a time window, unlike settlePromotedTurnFailure:
 * `fire_key` is a unique Scheduler occurrence identity, not a reused session
 * id, so it cannot match an unrelated failure however long the retries took.
 */
export async function settleCronFireFailure(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  params: { fireKey: string },
): Promise<void> {
  if (!config.databaseResourceArn || !config.databaseSecretArn) {
    throw new Error('Cron failure telemetry database is not configured');
  }
  await rdsDataClient.execute({
    resourceArn: config.databaseResourceArn,
    secretArn: config.databaseSecretArn,
    database: config.databaseName,
    sql: `UPDATE agent_failures
             SET acknowledged = TRUE,
                 acknowledged_by = 'system:fire-succeeded',
                 acknowledged_at = NOW(),
                 context = COALESCE(context, '{}'::jsonb)
                           || '{"settledByLaterSuccess":true}'::jsonb
           WHERE source = 'cron'
             AND fire_key = :fire_key
             AND acknowledged = FALSE`,
    parameters: [{ name: 'fire_key', value: { stringValue: params.fireKey } }],
  });
}

type CronFailureRecorder = (
  params: CronFailureRecord,
  log: CronTelemetryLogger,
) => Promise<void>;

function preflightFailureRecord(
  params: ScheduledRunRecord,
): CronFailureRecord {
  return {
    userEmail: params.userEmail,
    sessionId: params.sessionId,
    scheduleId: params.scheduleId,
    scheduleName: params.scheduleName,
    errorMessage: params.errorMessage ?? null,
    severity: params.failure?.severity,
    context: params.failure?.context ?? { phase: 'schedule-preflight' },
    fireKey: params.fireKey,
  };
}

function createPreflightRecorder(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  databaseConfigured: boolean,
  recordCronFailure: CronFailureRecorder,
): RunTelemetry['recordPreflightRun'] {
  return async (params, log) => {
    const failure = preflightFailureRecord(params);
    const hasFailure = params.status === 'error' || Boolean(params.failure);
    if (!databaseConfigured) {
      if (hasFailure) await recordCronFailure(failure, log);
      log.warn('Database not configured — skipping preflight telemetry', {
        scheduleId: params.scheduleId,
      });
      return;
    }

    let storedStatus: string;
    try {
      storedStatus = await writePreflightRun(config, rdsDataClient, params);
    } catch (error) {
      if (hasFailure) await recordCronFailure(failure, log);
      log.error('Failed to write preflight run telemetry', {
        scheduleId: params.scheduleId,
        error: sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return;
    }

    // Repair a missing mirror on retry only when the durable row is itself an
    // error. A stale lookup failure must not create a failure beside an
    // existing promoted or successful occurrence.
    if (hasFailure && storedStatus === 'error') {
      await recordCronFailure(failure, log);
    }
  };
}

/**
 * Best-effort reader of a schedule's current failure streak.
 *
 * `null` means "unreadable", which the caller must treat as "do not notify"
 * rather than "no failures". Guessing either way from a read error would
 * produce the exact noise the suppression rule exists to prevent.
 */
/**
 * The two best-effort history operations the owner-notice rule needs, built
 * together so the factory below stays readable.
 */
function createBestEffortRunReaders(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  databaseConfigured: boolean,
): Pick<RunTelemetry, 'failureStreak' | 'markOwnerNotified'> {
  return {
    failureStreak: createFailureStreakReader(
      config,
      rdsDataClient,
      databaseConfigured,
    ),
    markOwnerNotified: createOwnerNotifiedStamper(
      config,
      rdsDataClient,
      databaseConfigured,
    ),
  };
}

function createFailureStreakReader(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  databaseConfigured: boolean,
): RunTelemetry['failureStreak'] {
  return async (params, log) => {
    if (!databaseConfigured) return null;
    try {
      return await readFailureStreak(config, rdsDataClient, params);
    } catch (error) {
      log.warn('Failed to read a schedule failure streak', {
        scheduleId: params.scheduleId,
        error: sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return null;
    }
  };
}

/**
 * Best-effort stamper for the run that carried the owner's failure message.
 * Never throws: the message has already been delivered by the time this runs.
 */
function createOwnerNotifiedStamper(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
  databaseConfigured: boolean,
): RunTelemetry['markOwnerNotified'] {
  return async (params, log) => {
    if (!databaseConfigured) return;
    try {
      await markOwnerNotified(config, rdsDataClient, params);
    } catch (error) {
      log.warn('Failed to stamp the run that notified a schedule owner', {
        scheduleId: params.scheduleId,
        error: sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  };
}

export function createRunTelemetry(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
): RunTelemetry {
  const databaseConfigured =
    config.databaseResourceArn.length > 0 &&
    config.databaseSecretArn.length > 0;
  const bestEffortReads =
    createBestEffortRunReaders(config, rdsDataClient, databaseConfigured);

  function logCronFailure(
    params: CronFailureRecord,
    log: CronTelemetryLogger,
  ): void {
    const severity = params.severity ?? 'error';
    const truncatedError = params.errorMessage
      ? sanitizeDiagnostic(params.errorMessage, 4000)
      : null;
    log.error('AGENT_FAILURE_RECORD', {
      source: 'cron',
      severity,
      userId: sanitizeEmailForLog(params.userEmail),
      sessionId: params.sessionId,
      scheduleId: params.scheduleId,
      scheduleName: params.scheduleName ?? null,
      errorMessage: truncatedError
        ? sanitizeDiagnostic(truncatedError)
        : null,
      context: params.context ?? {},
    });
  }

  async function recordCronFailure(
    params: CronFailureRecord,
    log: CronTelemetryLogger,
  ): Promise<void> {
    logCronFailure(params, log);
    if (!databaseConfigured) return;
    try {
      await writeCronFailure(config, rdsDataClient, params);
    } catch (error) {
      log.error('Failed to record cron failure mirror', {
        scheduleId: params.scheduleId,
        error: sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  async function recordCronFailureStrict(
    params: CronFailureRecord,
    log: CronTelemetryLogger,
  ): Promise<void> {
    logCronFailure(params, log);
    await writeCronFailure(config, rdsDataClient, params);
  }

  const recordPreflightRun = createPreflightRecorder(
    config,
    rdsDataClient,
    databaseConfigured,
    recordCronFailure,
  );

  /**
   * Acknowledge this fire's own failure row now that the fire has succeeded.
   *
   * Best-effort: a settle that cannot run leaves a stale warn row, which is a
   * noisy feed, not a broken run. It must never turn a successful scheduled
   * turn into a reported failure.
   */
  async function settleSucceededFire(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void> {
    if (!databaseConfigured) return;
    // Positive test, not "anything that isn't an error". `skipped` (coalesced
    // fire) and `promoted` (handed off to the job runner) are BOTH reachable
    // without a `failure` object, and neither is proof this occurrence did the
    // work — settling on them would acknowledge a live contention row for a
    // fire that never actually ran.
    if (params.status !== 'success') return;
    if (params.failure) return;
    if (!params.fireKey) return;
    try {
      await settleCronFireFailure(config, rdsDataClient, {
        fireKey: params.fireKey,
      });
    } catch (error) {
      log.warn('Failed to settle the contention row for a succeeded fire', {
        scheduleId: params.scheduleId,
        error: sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  async function recordRun(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void> {
    if (params.status === 'error' || params.failure) {
      // Failure visibility is the primary contract of this telemetry. Persist
      // its idempotent mirror before the run row so a hard crash cannot leave
      // a terminal error with no failure record.
      await recordCronFailure(
        {
          userEmail: params.userEmail,
          sessionId: params.sessionId,
          scheduleId: params.scheduleId,
          scheduleName: params.scheduleName,
          errorMessage: params.errorMessage ?? null,
          severity: params.failure?.severity,
          context: params.failure?.context ?? { phase: 'scheduled-run' },
          fireKey: params.fireKey,
        },
        log,
      );
    }

    if (!databaseConfigured) {
      log.warn('Database not configured — skipping run telemetry', {
        scheduleId: params.scheduleId,
      });
    } else {
      try {
        await writeScheduledRun(config, rdsDataClient, params);
      } catch (error) {
        log.error('Failed to record scheduled run', {
          scheduleId: params.scheduleId,
          error: sanitizeDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }

    await settleSucceededFire(params, log);
  }

  async function recordRunStrict(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void> {
    if (params.status === 'error' || params.failure) {
      await recordCronFailureStrict(
        {
          userEmail: params.userEmail,
          sessionId: params.sessionId,
          scheduleId: params.scheduleId,
          scheduleName: params.scheduleName,
          errorMessage: params.errorMessage ?? null,
          severity: params.failure?.severity,
          context: params.failure?.context ?? { phase: 'scheduled-run' },
          fireKey: params.fireKey,
        },
        log,
      );
    }
    await writeScheduledRun(config, rdsDataClient, params);
    // Strict callers still get a best-effort settle: the run itself succeeded,
    // and a stale contention row must not fail it.
    await settleSucceededFire(params, log);
  }

  return {
    ...bestEffortReads,
    recordPreflightRun,
    recordRun,
    recordRunStrict,
    recordCronFailure,
    recordCronFailureStrict,
  };
}
