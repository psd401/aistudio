import type {
  CronFailureRecord,
  ScheduledRunRecord,
} from './run-telemetry';
import { sanitizeEmailForLog } from './log-sanitization';

export interface JobRunnerStoppedEvent {
  source: 'aws.ecs';
  'detail-type': 'ECS Task State Change';
  time?: string;
  detail: {
    clusterArn: string;
    taskArn: string;
    lastStatus: 'STOPPED';
    stopCode?: string;
    stoppedReason?: string;
    containers?: JobTaskContainer[];
  };
}

export interface JobTaskContainer {
  name?: string;
  exitCode?: number;
  reason?: string;
}

export interface JobTaskSnapshot {
  taskArn?: string;
  createdAt?: Date;
  startedAt?: Date;
  stoppedAt?: Date;
  stopCode?: string;
  stoppedReason?: string;
  containers?: JobTaskContainer[];
  overrides?: {
    containerOverrides?: Array<{
      name?: string;
      environment?: Array<{
        name?: string;
        value?: string;
      }>;
    }>;
  };
}

interface ScheduledJobIdentity {
  scheduledRunId?: string;
  userEmail: string;
  scheduleId: string;
  scheduleName?: string;
  sessionId: string;
}

export interface JobMonitorLogger {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface JobMonitorDependencies {
  describeTask: (
    clusterArn: string,
    taskArn: string,
  ) => Promise<JobTaskSnapshot>;
  writeRun: (record: ScheduledRunRecord) => Promise<boolean>;
  recordFailure: (record: CronFailureRecord) => Promise<void>;
}

export interface JobMonitorResult {
  status: 'success' | 'error' | 'skipped';
  scheduleId: string;
}

function nonEmptyString(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    ? value
    : undefined;
}

function scheduledJobIdentity(rawPayload: string): ScheduledJobIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(rawPayload);
  } catch {
    throw new Error('Stopped job has an invalid JOB_PAYLOAD');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Stopped job has a non-object JOB_PAYLOAD');
  }
  const payload = value as Record<string, unknown>;
  const scheduleId = nonEmptyString(payload.scheduleId, 64);
  if (!scheduleId) return null;

  const userEmail = nonEmptyString(payload.userEmail, 255);
  const sessionId = nonEmptyString(payload.sessionId, 512);
  if (!userEmail || !sessionId) {
    throw new Error('Stopped scheduled job payload is missing its owner or session');
  }
  const scheduleName = nonEmptyString(payload.scheduleName, 120);
  const rawScheduledRunId = nonEmptyString(payload.scheduledRunId, 20);
  const scheduledRunId = rawScheduledRunId
    && /^\d{1,20}$/.test(rawScheduledRunId)
    ? rawScheduledRunId
    : undefined;
  return {
    ...(scheduledRunId ? { scheduledRunId } : {}),
    userEmail,
    scheduleId,
    ...(scheduleName ? { scheduleName } : {}),
    sessionId,
  };
}

function jobPayload(
  task: JobTaskSnapshot,
  containerName: string,
): string {
  const container = task.overrides?.containerOverrides?.find(
    (candidate) => candidate.name === containerName,
  );
  const payload = container?.environment?.find(
    (entry) => entry.name === 'JOB_PAYLOAD',
  )?.value;
  if (!payload) {
    throw new Error('Stopped job task has no recoverable JOB_PAYLOAD override');
  }
  return payload;
}

function stoppedContainer(
  event: JobRunnerStoppedEvent,
  task: JobTaskSnapshot,
  containerName: string,
): JobTaskContainer | undefined {
  return task.containers?.find((container) => container.name === containerName)
    ?? event.detail.containers?.find(
      (container) => container.name === containerName,
    );
}

function elapsedMs(
  event: JobRunnerStoppedEvent,
  task: JobTaskSnapshot,
): number {
  const start = task.startedAt ?? task.createdAt;
  const eventStoppedAt = event.time ? new Date(event.time) : undefined;
  const end = task.stoppedAt
    ?? (eventStoppedAt && !Number.isNaN(eventStoppedAt.getTime())
      ? eventStoppedAt
      : undefined);
  return start && end ? Math.max(0, end.getTime() - start.getTime()) : 0;
}

function stopError(
  event: JobRunnerStoppedEvent,
  task: JobTaskSnapshot,
  container: JobTaskContainer | undefined,
): string {
  const stopCode = task.stopCode ?? event.detail.stopCode ?? 'unknown';
  const reason = container?.reason
    ?? task.stoppedReason
    ?? event.detail.stoppedReason
    ?? 'no stopped reason';
  const exitCode = container?.exitCode;
  return [
    'Background job task stopped unsuccessfully',
    `stopCode=${stopCode}`,
    `exitCode=${exitCode ?? 'unknown'}`,
    reason,
  ].join('; ').slice(0, 4000);
}

export function isJobRunnerStoppedEvent(
  event: unknown,
): event is JobRunnerStoppedEvent {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as Record<string, unknown>;
  const detail = candidate.detail;
  return candidate.source === 'aws.ecs'
    && candidate['detail-type'] === 'ECS Task State Change'
    && !!detail
    && typeof detail === 'object'
    && (detail as Record<string, unknown>).lastStatus === 'STOPPED'
    && typeof (detail as Record<string, unknown>).clusterArn === 'string'
    && typeof (detail as Record<string, unknown>).taskArn === 'string';
}

/**
 * Ensure an authoritative terminal row exists after ECS reports the task
 * STOPPED. This covers image-pull/startup/hard-process failures and also
 * repairs a runner-local telemetry outage. The injected write is strict and
 * idempotent so Lambda's async retry/DLQ path runs without replacing a richer
 * terminal row already persisted by the job runner.
 */
export async function monitorStoppedJob(
  event: JobRunnerStoppedEvent,
  containerName: string,
  dependencies: JobMonitorDependencies,
  log: JobMonitorLogger,
): Promise<JobMonitorResult> {
  const task = await dependencies.describeTask(
    event.detail.clusterArn,
    event.detail.taskArn,
  );
  const identity = scheduledJobIdentity(jobPayload(task, containerName));
  if (!identity) {
    log.info('Interactive background job stop needs no schedule telemetry', {
      taskArn: event.detail.taskArn,
    });
    return { status: 'skipped', scheduleId: 'interactive' };
  }

  const container = stoppedContainer(event, task, containerName);
  const status = container?.exitCode === 0 ? 'success' : 'error';
  const errorMessage = status === 'error'
    ? stopError(event, task, container)
    : undefined;
  const record: ScheduledRunRecord = {
    ...identity,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: elapsedMs(event, task),
    status,
    ...(errorMessage ? { errorMessage } : {}),
  };

  const terminalRepaired = await dependencies.writeRun(record);
  if (errorMessage && terminalRepaired) {
    await dependencies.recordFailure({
      ...identity,
      errorMessage,
      severity: 'error',
      context: {
        phase: 'job-supervisor',
        taskArn: event.detail.taskArn,
        stopCode: task.stopCode ?? event.detail.stopCode ?? null,
        exitCode: container?.exitCode ?? null,
      },
    });
    log.error('Scheduled background job stopped unsuccessfully', {
      scheduleId: identity.scheduleId,
      owner: sanitizeEmailForLog(identity.userEmail),
      taskArn: event.detail.taskArn,
      exitCode: container?.exitCode ?? null,
    });
  } else {
    log.info('Scheduled background job terminal state confirmed', {
      scheduleId: identity.scheduleId,
      owner: sanitizeEmailForLog(identity.userEmail),
      taskArn: event.detail.taskArn,
    });
  }
  return { status, scheduleId: identity.scheduleId };
}
