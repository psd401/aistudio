import type {
  DeleteCommandInput,
  PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import * as crypto from 'node:crypto';

interface JobLockLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface JobLockDynamoClient {
  put(input: PutCommandInput): Promise<unknown>;
  delete(input: DeleteCommandInput): Promise<unknown>;
}

export type JobLockResult =
  | { acquired: true; lockToken: string }
  | {
      acquired: false;
      phase: 'lock-config' | 'lock-contention' | 'lock-acquire';
      severity: 'error' | 'warn';
      errorMessage: string;
    };

export async function tryAcquireJobLock(
  sessionId: string,
  tableName: string,
  dynamoClient: JobLockDynamoClient,
  log: JobLockLogger,
): Promise<JobLockResult> {
  if (!tableName) {
    const errorMessage = 'SESSION_LOCKS_TABLE is not configured';
    log.warn(`Job promotion skipped — ${errorMessage}`);
    return {
      acquired: false,
      phase: 'lock-config',
      severity: 'error',
      errorMessage,
    };
  }
  const lockToken = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  try {
    await dynamoClient.put(
      {
        TableName: tableName,
        Item: {
          sessionId,
          expiresAt: nowS + 14 * 60,
          lockToken,
          kind: 'job',
          claimedAt: new Date().toISOString(),
        },
        ConditionExpression:
          'attribute_not_exists(sessionId) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': nowS },
      },
    );
    return { acquired: true, lockToken };
  } catch (error) {
    const errorName = (error as { name?: string } | null)?.name;
    if (errorName === 'ConditionalCheckFailedException') {
      const errorMessage =
        'Session lock contended; another invocation owns this schedule session';
      log.warn('Job promotion aborted — session lock contended');
      return {
        acquired: false,
        phase: 'lock-contention',
        severity: 'warn',
        errorMessage,
      };
    }
    const errorMessage =
      `Session lock acquire failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    log.warn('Job promotion aborted — session lock acquire failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      acquired: false,
      phase: 'lock-acquire',
      severity: 'error',
      errorMessage,
    };
  }
}

export async function releaseJobLock(
  sessionId: string,
  lockToken: string,
  tableName: string,
  dynamoClient: JobLockDynamoClient,
  log: JobLockLogger,
): Promise<void> {
  if (!tableName) return;
  try {
    await dynamoClient.delete(
      {
        TableName: tableName,
        Key: { sessionId },
        ConditionExpression: 'lockToken = :token',
        ExpressionAttributeValues: { ':token': lockToken },
      },
    );
  } catch (error) {
    const errorName = (error as { name?: string } | null)?.name;
    if (errorName === 'ConditionalCheckFailedException') return;
    log.warn('Job lock release failed; relying on TTL backstop', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
