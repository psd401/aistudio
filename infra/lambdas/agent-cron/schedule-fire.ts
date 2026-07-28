import type {
  DeleteCommandInput,
  GetCommandInput,
  PutCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import * as crypto from 'node:crypto';
import type { ScheduleReferenceEvent } from './schedule-record';

const RUNNING_LEASE_SECONDS = 16 * 60;
const COMPLETED_MARKER_SECONDS = 65 * 60;

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

export interface ScheduleFireFailure {
  phase: 'fire-config' | 'fire-acquire' | 'fire-in-progress' | 'fire-completed';
  severity: 'error' | 'warn';
  errorMessage: string;
  retryable: boolean;
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
        status: 'running',
        scheduledTime: identity.scheduledTime,
        lockToken: claimToken,
        claimedAt: new Date().toISOString(),
        expiresAt: nowS + RUNNING_LEASE_SECONDS,
      },
      ConditionExpression:
        'attribute_not_exists(sessionId) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': nowS },
    });
    return { claimed: true, identity, claimToken };
  } catch (error) {
    if (errorName(error) !== 'ConditionalCheckFailedException') {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn('Schedule fire claim failed', { error: detail });
      return {
        claimed: false,
        failure: {
          phase: 'fire-acquire',
          severity: 'error',
          errorMessage: `Schedule fire claim failed: ${detail}`,
          retryable: true,
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
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn('Schedule fire state lookup failed', { error: detail });
    return {
      claimed: false,
      failure: {
        phase: 'fire-acquire',
        severity: 'error',
        errorMessage: `Schedule fire state lookup failed: ${detail}`,
        retryable: true,
      },
    };
  }
}

export async function completeScheduleFire(
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
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn('Schedule fire completion marker failed', {
      error: detail,
    });
    throw new Error(
      `Schedule fire completion marker failed: ${detail}`,
      { cause: error },
    );
  }
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
      ConditionExpression: 'lockToken = :token',
      ExpressionAttributeValues: { ':token': claim.claimToken },
    });
  } catch (error) {
    if (errorName(error) === 'ConditionalCheckFailedException') return;
    const deleteDetail =
      error instanceof Error ? error.message : String(error);
    log.warn('Schedule fire claim delete failed; expiring the claim', {
      error: deleteDetail,
    });
    try {
      await dynamoClient.update({
        TableName: tableName,
        Key: { sessionId: claim.identity.key },
        UpdateExpression:
          'SET #status = :failed, expiresAt = :expiredAt',
        ConditionExpression: 'lockToken = :token',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':expiredAt': Math.floor(Date.now() / 1000) - 1,
          ':token': claim.claimToken,
        },
      });
    } catch (expireError) {
      if (errorName(expireError) === 'ConditionalCheckFailedException') return;
      const expireDetail =
        expireError instanceof Error
          ? expireError.message
          : String(expireError);
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
