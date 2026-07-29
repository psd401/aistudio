import type {
  CronFailureRecord,
  ScheduledRunRecord,
} from './run-telemetry';

export const SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS = 8 * 60;

export interface ScheduledRunReconciliationMessage {
  type: 'scheduled-run-reconciliation';
  scheduledRunId: string;
  fireKey: string;
  userEmail: string;
  scheduleId: string;
  scheduleName: string;
  sessionId: string;
  startedBy: string;
}

export interface ScheduledRunReconciliationDependencies {
  isPending: (
    message: ScheduledRunReconciliationMessage,
  ) => Promise<boolean>;
  findTask: (startedBy: string) => Promise<string | undefined>;
  terminalize: (record: ScheduledRunRecord) => Promise<boolean>;
  recordFailure: (record: CronFailureRecord) => Promise<void>;
}

export type ScheduledRunReconciliationResult =
  | {
      status: 'task-found';
      taskArn: string;
    }
  | {
      status: 'no-pending-run';
    }
  | {
      status: 'terminalized';
      errorMessage: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
  ) {
    throw new Error(`Invalid scheduled-run reconciliation ${key}`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
  ) {
    throw new Error(`Invalid scheduled-run reconciliation ${key}`);
  }
  return value;
}

export function parseScheduledRunReconciliationMessage(
  body: string,
): ScheduledRunReconciliationMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Invalid scheduled-run reconciliation JSON');
  }
  const record = asRecord(parsed);
  if (!record || record.type !== 'scheduled-run-reconciliation') {
    throw new Error('Invalid scheduled-run reconciliation type');
  }
  const scheduledRunId = requiredString(record, 'scheduledRunId', 20);
  if (!/^\d{1,20}$/.test(scheduledRunId)) {
    throw new Error('Invalid scheduled-run reconciliation scheduledRunId');
  }
  const startedBy = requiredString(record, 'startedBy', 36);
  if (!/^scheduled-[a-f0-9]{26}$/.test(startedBy)) {
    throw new Error('Invalid scheduled-run reconciliation startedBy');
  }
  return {
    type: 'scheduled-run-reconciliation',
    scheduledRunId,
    // Messages written by a pre-fire-key cron bundle can remain queued during
    // a rolling deploy. Their reserved row ID is immutable and therefore a
    // safe idempotency key for repairing the corresponding failure mirror.
    fireKey:
      optionalString(record, 'fireKey', 192)
      ?? `scheduled-run#${scheduledRunId}`,
    userEmail: requiredString(record, 'userEmail', 320),
    scheduleId: requiredString(record, 'scheduleId', 128),
    scheduleName: requiredString(record, 'scheduleName', 200),
    sessionId: requiredString(record, 'sessionId', 128),
    startedBy,
  };
}

/**
 * Resolve a launch only after the SQS delivery delay has outlived ECS's
 * eventual-consistency guidance. Lookup/write failures throw so SQS retries
 * and eventually moves the message to the alarmed DLQ.
 */
export async function reconcileScheduledRun(
  message: ScheduledRunReconciliationMessage,
  dependencies: ScheduledRunReconciliationDependencies,
): Promise<ScheduledRunReconciliationResult> {
  if (!await dependencies.isPending(message)) {
    return { status: 'no-pending-run' };
  }
  const taskArn = await dependencies.findTask(message.startedBy);
  if (taskArn) return { status: 'task-found', taskArn };

  const errorMessage =
    `Background launch remained ambiguous: no ECS task with startedBy ` +
    `${message.startedBy} was visible after the durable ` +
    `${SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS}-second consistency window`;

  // Persist the idempotent failure first. If this succeeds and terminalization
  // fails, SQS retries and upserts the same fire. If it fails, the promoted row
  // remains pending and the message retries. There is no crash point that can
  // leave a terminal error row without its failure mirror.
  await dependencies.recordFailure({
    userEmail: message.userEmail,
    scheduleId: message.scheduleId,
    fireKey: message.fireKey,
    scheduleName: message.scheduleName,
    sessionId: message.sessionId,
    errorMessage,
    severity: 'error',
    context: {
      phase: 'run-task-ambiguous-terminal',
      scheduledRunId: message.scheduledRunId,
      consistencyWindowSeconds:
        SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS,
    },
  });
  const updated = await dependencies.terminalize({
    scheduledRunId: message.scheduledRunId,
    fireKey: message.fireKey,
    userEmail: message.userEmail,
    scheduleId: message.scheduleId,
    scheduleName: message.scheduleName,
    sessionId: message.sessionId,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS * 1000,
    status: 'error',
    errorMessage,
  });
  if (!updated) return { status: 'no-pending-run' };
  return { status: 'terminalized', errorMessage };
}
