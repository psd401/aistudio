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
}

export interface ScheduledRunRecord {
  /** Primary-key correlation for a promoted run; absent on ordinary cron rows. */
  scheduledRunId?: string;
  userEmail: string;
  scheduleId: string;
  scheduleName?: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: 'success' | 'error' | 'skipped' | 'promoted';
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

export interface RunTelemetry {
  recordRun(
    params: ScheduledRunRecord,
    log: CronTelemetryLogger,
  ): Promise<void>;
  recordCronFailure(
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
  return [
    { name: 'user_id', value: { stringValue: params.userEmail } },
    { name: 'schedule_id', value: { stringValue: params.scheduleId } },
    nullableStringParameter('schedule_name', params.scheduleName),
    { name: 'session_id', value: { stringValue: params.sessionId } },
    { name: 'input_tokens', value: { longValue: params.inputTokens } },
    { name: 'output_tokens', value: { longValue: params.outputTokens } },
    { name: 'latency_ms', value: { longValue: params.latencyMs } },
    { name: 'status', value: { stringValue: params.status } },
    nullableStringParameter('error_message', params.errorMessage),
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
               input_tokens, output_tokens, latency_ms, status, error_message)
            VALUES
              (:user_id, :schedule_id, :schedule_name, :session_id,
               :input_tokens, :output_tokens, :latency_ms, :status, :error_message)`,
      parameters: scheduledRunParameters(params),
    },
  );
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
               input_tokens, output_tokens, latency_ms, status, error_message)
            OVERRIDING SYSTEM VALUE
            VALUES
              (CAST(:scheduled_run_id AS bigint), :user_id, :schedule_id,
               :schedule_name, :session_id, :input_tokens, :output_tokens,
               :latency_ms, :status, :error_message)
            RETURNING CAST(id AS TEXT)`
        : `INSERT INTO agent_scheduled_runs
              (user_id, schedule_id, schedule_name, session_id,
               input_tokens, output_tokens, latency_ms, status, error_message)
            VALUES
              (:user_id, :schedule_id, :schedule_name, :session_id,
               :input_tokens, :output_tokens, :latency_ms, :status, :error_message)
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

export function createRunTelemetry(
  config: RunTelemetryConfig,
  rdsDataClient: RunTelemetryRdsClient,
): RunTelemetry {
  const databaseConfigured =
    config.databaseResourceArn.length > 0 &&
    config.databaseSecretArn.length > 0;

  async function recordCronFailure(
    params: CronFailureRecord,
    log: CronTelemetryLogger,
  ): Promise<void> {
    const severity = params.severity ?? 'error';
    const truncatedError = params.errorMessage
      ? sanitizeDiagnostic(params.errorMessage, 4000)
      : null;
    const context = JSON.stringify({
      scheduleId: params.scheduleId,
      ...params.context,
    });

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

    if (!databaseConfigured) return;
    try {
      await rdsDataClient.execute(
        {
          resourceArn: config.databaseResourceArn,
          secretArn: config.databaseSecretArn,
          database: config.databaseName,
          sql: `INSERT INTO agent_failures
                  (source, severity, user_id, session_id, schedule_name,
                   error_message, context, occurred_at)
                VALUES
                  ('cron', :severity, :user_id, :session_id, :schedule_name,
                   :error_message, CAST(:context AS jsonb), NOW())`,
          parameters: [
            { name: 'severity', value: { stringValue: severity } },
            { name: 'user_id', value: { stringValue: params.userEmail } },
            { name: 'session_id', value: { stringValue: params.sessionId } },
            nullableStringParameter('schedule_name', params.scheduleName),
            nullableStringParameter('error_message', truncatedError),
            { name: 'context', value: { stringValue: context } },
          ],
        },
      );
    } catch (error) {
      log.error('Failed to record cron failure mirror', {
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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (params.status === 'error' || params.failure) {
      await recordCronFailure(
        {
          userEmail: params.userEmail,
          sessionId: params.sessionId,
          scheduleId: params.scheduleId,
          scheduleName: params.scheduleName,
          errorMessage: params.errorMessage ?? null,
          severity: params.failure?.severity,
          context: params.failure?.context ?? { phase: 'scheduled-run' },
        },
        log,
      );
    }
  }

  return { recordRun, recordCronFailure };
}
