import type {
  DeleteCommandInput,
  GetCommandInput,
  PutCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import * as crypto from 'node:crypto';
import type { JobLockFailure } from './job-lock';
import type { ScheduleReferenceEvent } from './schedule-record';
import { sanitizeDiagnostic } from './diagnostic-sanitization';

// A newly acquired fire has not performed external work and can be reclaimed
// quickly after a hard crash. Immediately before execution, the owner
// conditionally advances it to the long lease below.
const ACQUIRED_LEASE_SECONDS = 5;
// EventBridge Scheduler retries this target for at most 60 minutes. Once work
// may have started, keep the fire claimed beyond that horizon to prevent replay.
const EXECUTING_LEASE_SECONDS = 65 * 60;
const COMPLETED_MARKER_SECONDS = 65 * 60;
const ECS_STARTED_BY_MAX_LENGTH = 36;
const SCHEDULED_STARTED_BY_PREFIX = 'scheduled-';
const SCHEDULED_STARTED_BY_DIGEST_LENGTH =
  ECS_STARTED_BY_MAX_LENGTH - SCHEDULED_STARTED_BY_PREFIX.length;

interface ScheduleFireLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface ScheduleFireDynamoClient {
  put(input: PutCommandInput): Promise<unknown>;
  get(input: GetCommandInput): Promise<{
    Item?: Record<string, unknown>;
  }>;
  update(input: UpdateCommandInput): Promise<unknown>;
  delete(input: DeleteCommandInput): Promise<unknown>;
}

export interface ScheduleFireIdentity {
  key: string;
  scheduledTime: string;
}

export interface ScheduleFireLaunchIdentity {
  clientToken: string;
  startedBy: string;
}

export interface ScheduleFireFailure {
  phase:
    | 'fire-config'
    | 'fire-acquire'
    | 'fire-begin'
    | 'fire-in-progress'
    | 'fire-executing'
    | 'fire-completed'
    | 'fire-completion';
  severity: 'error' | 'warn';
  errorMessage: string;
  retryable: boolean;
  recordRun: boolean;
}

export type ScheduleFireClaim =
  | {
      claimed: true;
      identity: ScheduleFireIdentity;
      claimToken: string;
    }
  | {
      claimed: false;
      failure: ScheduleFireFailure;
    };

export type ScheduleFireCompletion =
  | { persisted: true }
  | {
      persisted: false;
      errorMessage: string;
    };

export class ScheduleFireExecutionError extends Error {
  readonly failure: ScheduleFireFailure;

  constructor(failure: ScheduleFireFailure) {
    super(failure.errorMessage);
    this.name = 'ScheduleFireExecutionError';
    this.failure = failure;
  }
}

export type ScheduleLockContentionResolution =
  | {
      action: 'coalesce';
      failure: JobLockFailure;
      fireClaim: Extract<ScheduleFireClaim, { claimed: true }>;
    }
  | {
      action: 'retry';
      failure: JobLockFailure;
      fireClaim?: Extract<ScheduleFireClaim, { claimed: true }>;
    };

/**
 * Distinct fires share a daily AgentCore session. If its prior background turn
 * is still active, queueing every high-frequency fire would deliver stale
 * prompts in a burst after the lock clears. Coalesce only when the lock names
 * a different fire. Legacy or uncorrelated locks may represent the same fire
 * and must remain retryable.
 */
export function resolveScheduleLockContention(
  failure: JobLockFailure,
  fireClaim: Extract<ScheduleFireClaim, { claimed: true }> | null,
): ScheduleLockContentionResolution {
  if (
    fireClaim
    && (
      failure.ownerFireKey === fireClaim.identity.key
      || failure.ownerFireKey === null
      || failure.ownerFireKey === undefined
    )
  ) {
    return {
      action: 'retry',
      fireClaim,
      failure: {
        ...failure,
        severity: 'error',
        errorMessage:
          'Scheduled fire session lock is owned by the same fire; retrying',
      },
    };
  }
  if (fireClaim) {
    return {
      action: 'coalesce',
      fireClaim,
      failure: {
        ...failure,
        errorMessage:
          'Scheduled fire was coalesced because its daily session is still active',
      },
    };
  }
  return {
    action: 'retry',
    failure: {
      ...failure,
      severity: 'error',
      errorMessage:
        'Legacy scheduled fire contended; retrying without acknowledging',
    },
  };
}

function errorName(error: unknown): string | undefined {
  return (error as { name?: string } | null)?.name;
}

function validScheduledTime(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length >= 20
    && value.length <= 40
    && value.endsWith('Z')
    && value[4] === '-'
    && value[7] === '-'
    && value[10] === 'T'
    && value[13] === ':'
    && value[16] === ':'
    && Number.isFinite(Date.parse(value))
  );
}

export function scheduleFireIdentity(
  event: ScheduleReferenceEvent,
): ScheduleFireIdentity | null {
  if (
    typeof event.scheduleId !== 'string'
    || !validScheduledTime(event.scheduledTime)
  ) {
    return null;
  }
  return {
    key: `schedule-fire#${event.scheduleId}#${event.scheduledTime}`,
    scheduledTime: event.scheduledTime,
  };
}

/**
 * ECS launch identity is derived from immutable Scheduler fire identity, not
 * from a renewable lock token or a newly inserted telemetry row.
 */
export function scheduleFireLaunchIdentity(
  identity: ScheduleFireIdentity,
): ScheduleFireLaunchIdentity {
  const digest = crypto
    .createHash('sha256')
    .update(identity.key)
    .digest('hex');
  return {
    clientToken: digest,
    startedBy: scheduledRunStartedBy(digest),
  };
}

/**
 * ECS limits startedBy to 36 characters. Retain the full SHA-256 digest in the
 * client token and use a 104-bit prefix for task discovery/correlation.
 */
export function scheduledRunStartedBy(digest: string): string {
  return (
    SCHEDULED_STARTED_BY_PREFIX
    + digest.slice(0, SCHEDULED_STARTED_BY_DIGEST_LENGTH)
  );
}

export async function claimScheduleFire(
  identity: ScheduleFireIdentity,
  tableName: string,
  dynamoClient: ScheduleFireDynamoClient,
  log: ScheduleFireLogger,
): Promise<ScheduleFireClaim> {
  if (!tableName) {
    return {
      claimed: false,
      failure: {
        phase: 'fire-config',
        severity: 'error',
        errorMessage: 'SESSION_LOCKS_TABLE is not configured',
        retryable: true,
        recordRun: true,
      },
    };
  }

  const claimToken = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  try {
    await dynamoClient.put({
      TableName: tableName,
      Item: {
        sessionId: identity.key,
        kind: 'schedule-fire',
        status: 'claimed',
        scheduledTime: identity.scheduledTime,
        lockToken: claimToken,
        claimedAt: new Date().toISOString(),
        expiresAt: nowS + ACQUIRED_LEASE_SECONDS,
      },
      // A claimed marker has not crossed the execution boundary, so a
      // redelivery may safely replace it after this short lease. Keeping the
      // token stable during normal job-lock acquisition avoids a replacement
      // racing the predecessor's conditional execution transition.
      ConditionExpression:
        'attribute_not_exists(sessionId) OR expiresAt < :now',
      ExpressionAttributeValues: {
        ':now': nowS,
      },
    });
    return { claimed: true, identity, claimToken };
  } catch (error) {
    if (errorName(error) !== 'ConditionalCheckFailedException') {
      const detail = sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      );
      log.warn('Schedule fire claim failed', { error: detail });
      return {
        claimed: false,
        failure: {
          phase: 'fire-acquire',
          severity: 'error',
          errorMessage: `Schedule fire claim failed: ${detail}`,
          retryable: true,
          recordRun: true,
        },
      };
    }
  }

  try {
    const existing = await dynamoClient.get({
      TableName: tableName,
      Key: { sessionId: identity.key },
      ConsistentRead: true,
    });
    if (existing.Item?.status === 'completed') {
      return {
        claimed: false,
        failure: {
          phase: 'fire-completed',
          severity: 'warn',
          errorMessage: 'Scheduled fire was already completed',
          retryable: false,
          recordRun: false,
        },
      };
    }
    if (existing.Item?.status === 'executing') {
      return {
        claimed: false,
        failure: {
          phase: 'fire-executing',
          severity: 'error',
          errorMessage:
            'Scheduled fire execution may have started; replay is blocked',
          retryable: true,
          recordRun: false,
        },
      };
    }
    return {
      claimed: false,
      failure: {
        phase: 'fire-in-progress',
        severity: 'error',
        errorMessage: 'Scheduled fire is still in progress',
        retryable: true,
        recordRun: false,
      },
    };
  } catch (error) {
    const detail = sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    log.warn('Schedule fire state lookup failed', { error: detail });
    return {
      claimed: false,
      failure: {
        phase: 'fire-acquire',
        severity: 'error',
        errorMessage: `Schedule fire state lookup failed: ${detail}`,
        retryable: true,
        recordRun: true,
      },
    };
  }
}

/**
 * Advance a recoverable claim to the replay-blocking phase immediately before
 * the invocation can perform external work. The token condition ensures a
 * predecessor that stalled past the short claim lease cannot start after a
 * retry has taken ownership.
 */
export async function beginScheduleFireExecution(
  claim: Extract<ScheduleFireClaim, { claimed: true }>,
  tableName: string,
  dynamoClient: ScheduleFireDynamoClient,
  log: ScheduleFireLogger,
): Promise<void> {
  try {
    await dynamoClient.update({
      TableName: tableName,
      Key: { sessionId: claim.identity.key },
      UpdateExpression:
        'SET #status = :executing, executionStartedAt = :startedAt, expiresAt = :expiresAt',
      ConditionExpression: 'lockToken = :token AND #status = :claimed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':executing': 'executing',
        ':claimed': 'claimed',
        ':startedAt': new Date().toISOString(),
        ':expiresAt':
          Math.floor(Date.now() / 1000) + EXECUTING_LEASE_SECONDS,
        ':token': claim.claimToken,
      },
    });
  } catch (error) {
    const ownershipLost =
      errorName(error) === 'ConditionalCheckFailedException';
    const detail = sanitizeDiagnostic(
      ownershipLost
        ? 'schedule fire execution ownership was lost'
        : error instanceof Error
          ? error.message
          : String(error),
    );
    log.warn('Schedule fire execution transition failed', {
      error: detail,
    });
    throw new ScheduleFireExecutionError({
      phase: 'fire-begin',
      severity: 'error',
      errorMessage: `Schedule fire execution transition failed: ${detail}`,
      retryable: true,
      // A replacement owns this same fire and may succeed. Do not append a
      // newer error row that could mask its terminal result.
      recordRun: !ownershipLost,
    });
  }
}

export async function completeScheduleFire(
  claim: Extract<ScheduleFireClaim, { claimed: true }>,
  tableName: string,
  dynamoClient: ScheduleFireDynamoClient,
  log: ScheduleFireLogger,
): Promise<ScheduleFireCompletion> {
  const updateInput: UpdateCommandInput = {
    TableName: tableName,
    Key: { sessionId: claim.identity.key },
    UpdateExpression:
      'SET #status = :completed, completedAt = :completedAt, expiresAt = :expiresAt',
    ConditionExpression: 'lockToken = :token',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':completed': 'completed',
      ':completedAt': new Date().toISOString(),
      ':expiresAt':
        Math.floor(Date.now() / 1000) + COMPLETED_MARKER_SECONDS,
      ':token': claim.claimToken,
    },
  };
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await dynamoClient.update(updateInput);
      return { persisted: true };
    } catch (error) {
      const detail = sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      );
      failures.push(`update ${attempt}: ${detail}`);
      log.warn('Schedule fire completion marker write failed', {
        attempt,
        error: detail,
      });
    }

    try {
      const existing = await dynamoClient.get({
        TableName: tableName,
        Key: { sessionId: claim.identity.key },
        ConsistentRead: true,
      });
      if (
        existing.Item?.status === 'completed'
        && existing.Item?.lockToken === claim.claimToken
      ) {
        return { persisted: true };
      }
    } catch (error) {
      const detail = sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      );
      failures.push(`verify ${attempt}: ${detail}`);
      log.warn('Schedule fire completion verification failed', {
        attempt,
        error: detail,
      });
    }
  }
  const errorMessage =
    `Schedule fire completion marker failed: ${failures.join('; ')}`;
  log.warn('Schedule fire completion remains undurable; claim retained', {
    error: errorMessage,
  });
  return { persisted: false, errorMessage };
}

export async function releaseScheduleFire(
  claim: Extract<ScheduleFireClaim, { claimed: true }>,
  tableName: string,
  dynamoClient: ScheduleFireDynamoClient,
  log: ScheduleFireLogger,
): Promise<void> {
  try {
    await dynamoClient.delete({
      TableName: tableName,
      Key: { sessionId: claim.identity.key },
      // Cleanup is valid only before the execution boundary. Even if a future
      // caller accidentally attempts to release an executing/completed fire,
      // this condition retains the replay-blocking marker.
      ConditionExpression:
        'lockToken = :token AND #status = :claimed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':token': claim.claimToken,
        ':claimed': 'claimed',
      },
    });
  } catch (error) {
    if (errorName(error) === 'ConditionalCheckFailedException') return;
    const deleteDetail = sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    log.warn('Schedule fire claim delete failed; expiring the claim', {
      error: deleteDetail,
    });
    try {
      await dynamoClient.update({
        TableName: tableName,
        Key: { sessionId: claim.identity.key },
        UpdateExpression:
          'SET #status = :failed, expiresAt = :expiredAt',
        ConditionExpression:
          'lockToken = :token AND #status = :claimed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':expiredAt': Math.floor(Date.now() / 1000) - 1,
          ':token': claim.claimToken,
          ':claimed': 'claimed',
        },
      });
    } catch (expireError) {
      if (errorName(expireError) === 'ConditionalCheckFailedException') return;
      const expireDetail = sanitizeDiagnostic(
        expireError instanceof Error
          ? expireError.message
          : String(expireError),
      );
      log.warn('Schedule fire claim expiration failed', {
        error: expireDetail,
      });
      throw new Error(
        `Schedule fire cleanup failed: ${deleteDetail}; ${expireDetail}`,
        { cause: expireError },
      );
    }
  }
}
