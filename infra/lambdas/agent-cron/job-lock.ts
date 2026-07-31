import type {
  DeleteCommandInput,
  GetCommandInput,
  PutCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import * as crypto from 'node:crypto';
import { sanitizeDiagnostic } from './diagnostic-sanitization';

export const JOB_LOCK_LEASE_SECONDS = 30 * 60;
export const JOB_LOCK_RENEW_INTERVAL_MS = 5 * 60 * 1000;

interface JobLockLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface JobLockDynamoClient {
  put(input: PutCommandInput): Promise<unknown>;
  get?(input: GetCommandInput): Promise<{
    Item?: Record<string, unknown>;
  }>;
  delete(input: DeleteCommandInput): Promise<unknown>;
}

export interface JobLockLeaseDynamoClient {
  update(input: UpdateCommandInput): Promise<unknown>;
}

export type JobLockResult =
  | { acquired: true; lockToken: string }
  | {
      acquired: false;
      phase:
        | 'lock-config'
        | 'lock-contention'
        | 'lock-acquire'
        | 'lock-renew';
      severity: 'error' | 'warn';
      errorMessage: string;
      ownerFireKey?: string | null;
    };

export type JobLockFailure = Exclude<JobLockResult, { acquired: true }>;

export class JobLockAcquisitionError extends Error {
  readonly failure: JobLockFailure;

  constructor(failure: JobLockFailure) {
    super(failure.errorMessage);
    this.name = 'JobLockAcquisitionError';
    this.failure = failure;
  }
}

export interface LockedJobExecution<T> {
  value: T;
  retainLock: boolean;
}

export interface JobLockRenewalScheduler {
  start(callback: () => void, intervalMs: number): unknown;
  stop(timer: unknown): void;
}

export type LockedJobResult<T> =
  | { executed: true; value: T }
  | { executed: false; lock: JobLockFailure };

export interface JobLockExecutionOptions<T> {
  execute: (lockToken: string) => Promise<LockedJobExecution<T>>;
  fireKey?: string;
  renewalScheduler?: JobLockRenewalScheduler;
}

const defaultJobLockRenewalScheduler: JobLockRenewalScheduler = {
  start: (callback, intervalMs) => setInterval(callback, intervalMs),
  stop: (timer) =>
    clearInterval(timer as ReturnType<typeof setInterval>),
};

export async function tryAcquireJobLock(
  sessionId: string,
  tableName: string,
  dynamoClient: JobLockDynamoClient,
  log: JobLockLogger,
  fireKey?: string,
): Promise<JobLockResult> {
  if (!tableName) {
    const errorMessage = 'SESSION_LOCKS_TABLE is not configured';
    log.warn(`Scheduled run skipped — ${errorMessage}`);
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
          // Covers cold restore, the Lambda's 14-minute harness budget, and
          // the wrapper's bounded final flush even if renewal is missed.
          expiresAt: nowS + JOB_LOCK_LEASE_SECONDS,
          lockToken,
          kind: 'job',
          claimedAt: new Date().toISOString(),
          ...(fireKey ? { fireKey } : {}),
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
      let ownerFireKey: string | null | undefined;
      if (fireKey) {
        if (!dynamoClient.get) {
          return {
            acquired: false,
            phase: 'lock-acquire',
            severity: 'error',
            errorMessage:
              'Session lock owner lookup is not configured',
          };
        }
        try {
          const current = await dynamoClient.get({
            TableName: tableName,
            Key: { sessionId },
            ConsistentRead: true,
          });
          ownerFireKey = current.Item
            ? typeof current.Item.fireKey === 'string'
              ? current.Item.fireKey
              : undefined
            : null;
        } catch (lookupError) {
          const detail = sanitizeDiagnostic(
            lookupError instanceof Error
              ? lookupError.message
              : String(lookupError),
          );
          log.warn('Scheduled run aborted — session lock lookup failed', {
            error: detail,
          });
          return {
            acquired: false,
            phase: 'lock-acquire',
            severity: 'error',
            errorMessage: `Session lock owner lookup failed: ${detail}`,
          };
        }
      }
      const errorMessage =
        'Session lock contended; another invocation owns this schedule session';
      log.warn('Scheduled run skipped — session lock contended');
      return {
        acquired: false,
        phase: 'lock-contention',
        severity: 'warn',
        errorMessage,
        ...(fireKey ? { ownerFireKey } : {}),
      };
    }
    const detail = sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    const errorMessage = `Session lock acquire failed: ${detail}`;
    log.warn('Scheduled run aborted — session lock acquire failed', {
      error: detail,
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
      error: sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}

export async function renewJobLock(
  sessionId: string,
  lockToken: string,
  tableName: string,
  dynamoClient: JobLockLeaseDynamoClient,
  log: JobLockLogger,
): Promise<JobLockResult> {
  if (!tableName) {
    return {
      acquired: false,
      phase: 'lock-config',
      severity: 'error',
      errorMessage: 'SESSION_LOCKS_TABLE is not configured',
    };
  }
  try {
    await dynamoClient.update({
      TableName: tableName,
      Key: { sessionId },
      UpdateExpression: 'SET expiresAt = :expiresAt',
      ConditionExpression: 'lockToken = :token',
      ExpressionAttributeValues: {
        ':expiresAt':
          Math.floor(Date.now() / 1000) + JOB_LOCK_LEASE_SECONDS,
        ':token': lockToken,
      },
    });
    return { acquired: true, lockToken };
  } catch (error) {
    const detail = sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    log.warn('Scheduled job lock renewal failed', { error: detail });
    return {
      acquired: false,
      phase: 'lock-renew',
      severity: 'error',
      errorMessage: `Session lock renewal failed: ${detail}`,
    };
  }
}

/**
 * Acquire a session lock before executing any scheduled turn. Confirmed turns
 * release it after delivery; uncertain completion and successful promotions
 * retain the token, preventing a duplicate invocation from reaching AgentCore
 * or launching a second job.
 */
export async function runWithJobLock<T>(
  sessionId: string,
  tableName: string,
  dynamoClient: JobLockDynamoClient & JobLockLeaseDynamoClient,
  log: JobLockLogger,
  options: JobLockExecutionOptions<T>,
): Promise<LockedJobResult<T>> {
  let lock = await tryAcquireJobLock(
    sessionId,
    tableName,
    dynamoClient,
    log,
    options.fireKey,
  );
  if (
    !lock.acquired
    && options.fireKey
    && lock.ownerFireKey === options.fireKey
  ) {
    try {
      await dynamoClient.delete({
        TableName: tableName,
        Key: { sessionId },
        ConditionExpression: 'fireKey = :fireKey',
        ExpressionAttributeValues: { ':fireKey': options.fireKey },
      });
    } catch (error) {
      if (
        (error as { name?: string } | null)?.name
        !== 'ConditionalCheckFailedException'
      ) {
        const detail = sanitizeDiagnostic(
          error instanceof Error ? error.message : String(error),
        );
        throw new JobLockAcquisitionError({
          acquired: false,
          phase: 'lock-acquire',
          severity: 'error',
          errorMessage: `Same-fire session lock cleanup failed: ${detail}`,
        });
      }
    }
    // A caller can own this fire claim only if the predecessor never advanced
    // it to executing. Clear that predecessor's correlated session lock and
    // retry once so Scheduler attempts are not consumed waiting for its TTL.
    lock = await tryAcquireJobLock(
      sessionId,
      tableName,
      dynamoClient,
      log,
      options.fireKey,
    );
  }
  if (!lock.acquired) {
    if (lock.severity === 'error') throw new JobLockAcquisitionError(lock);
    return { executed: false, lock };
  }

  const lockToken = lock.lockToken;
  // Fail safe once execution begins. A thrown callback may mean the transport
  // disconnected while AgentCore is still stopping OpenClaw or flushing its
  // workspace. Only an explicit completed execution may authorize deletion.
  let retainLock = true;
  let renewalInFlight: Promise<void> | undefined;
  const renewOnce = () => {
    if (renewalInFlight) return;
    renewalInFlight = (async () => {
      try {
        const renewal = await renewJobLock(
          sessionId,
          lockToken,
          tableName,
          dynamoClient,
          log,
        );
        if (!renewal.acquired) {
          log.warn('Scheduled turn workspace lock renewal was not confirmed', {
            phase: renewal.phase,
          });
        }
      } catch (error) {
        log.warn('Scheduled turn workspace lock renewal threw unexpectedly', {
          error: sanitizeDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        });
      } finally {
        renewalInFlight = undefined;
      }
    })();
  };
  const renewalScheduler =
    options.renewalScheduler ?? defaultJobLockRenewalScheduler;
  const renewalTimer = renewalScheduler.start(
    renewOnce,
    JOB_LOCK_RENEW_INTERVAL_MS,
  );
  try {
    const execution = await options.execute(lockToken);
    retainLock = execution.retainLock;
    return { executed: true, value: execution.value };
  } finally {
    renewalScheduler.stop(renewalTimer);
    const pendingRenewal = renewalInFlight;
    if (pendingRenewal) await pendingRenewal;
    if (!retainLock) {
      await releaseJobLock(
        sessionId,
        lockToken,
        tableName,
        dynamoClient,
        log,
      );
    }
  }
}
