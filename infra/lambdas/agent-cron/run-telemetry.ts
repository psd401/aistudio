import type { ExecuteStatementCommandInput } from '@aws-sdk/client-rds-data';
import { sanitizeEmailForLog } from './log-sanitization';

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
 * Strict, idempotent fallback for the ECS STOPPED supervisor. The job runner
 * normally writes the richer terminal row before exiting. Insert only when
 * that exact scheduled session has no terminal row so a supervisor retry (or
 * a clean job) cannot replace accurate token/error telemetry with its fallback.
 */
export async function writeTerminalRunIfMissing(
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
      sql: `INSERT INTO agent_scheduled_runs
              (user_id, schedule_id, schedule_name, session_id,
               input_tokens, output_tokens, latency_ms, status, error_message)
            SELECT
              :user_id, :schedule_id, :schedule_name, :session_id,
              :input_tokens, :output_tokens, :latency_ms, :status, :error_message
            WHERE NOT EXISTS (
              SELECT 1
              FROM agent_scheduled_runs
              WHERE user_id = :user_id
                AND schedule_id = :schedule_id
                AND session_id = :session_id
                AND status IN ('success', 'error')
            )`,
      parameters: scheduledRunParameters(params),
    },
  );
  const updated = result && typeof result === 'object'
    ? (result as { numberOfRecordsUpdated?: unknown }).numberOfRecordsUpdated
    : undefined;
  if (updated !== 0 && updated !== 1) {
    throw new Error('Scheduled-run fallback returned no update count');
  }
  return updated === 1;
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
    const truncatedError = params.errorMessage?.slice(0, 4000) ?? null;
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
      errorMessage: truncatedError?.slice(0, 500) ?? null,
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
        error: error instanceof Error ? error.message : String(error),
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
