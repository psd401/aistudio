import { sanitizeDiagnostic } from './diagnostic-sanitization';

export interface RunTaskFailure {
  reason?: string;
  detail?: string;
}

export interface RunTaskAttempt {
  taskArns: string[];
  failures: RunTaskFailure[];
}

export interface TaskLookupPage {
  taskArns: string[];
  nextToken?: string;
}

export interface ReconciledTaskDescription {
  taskArn?: string;
  startedBy?: string;
}

export interface RunTaskLookupDependencies {
  startedBy: string;
  listRunningTasks: () => Promise<string[]>;
  listStoppedTasks: (nextToken?: string) => Promise<TaskLookupPage>;
  describeTasks: (
    taskArns: string[],
  ) => Promise<ReconciledTaskDescription[]>;
}

export interface RunTaskReconciliationDependencies
  extends RunTaskLookupDependencies {
  runTask: () => Promise<RunTaskAttempt>;
  wait: (delayMs: number) => Promise<void>;
}

export type RunTaskReconciliationResult =
  | {
      status: 'accepted';
      taskArn: string;
      reconciled: boolean;
    }
  | {
      status: 'rejected';
      errorMessage: string;
    }
  | {
      status: 'ambiguous';
      errorMessage: string;
    };

type ThrownRunTaskResult = {
  status: 'rejected' | 'ambiguous';
  errorMessage: string;
};

// These lookups are discovery only. An empty result is never proof that ECS
// rejected the launch because ECS is eventually consistent.
const RECONCILIATION_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;
const MAX_STOPPED_TASK_PAGES = 10;
const MAX_FORMATTED_ERROR_LENGTH = 200;

const DEFINITIVE_RUN_TASK_ERRORS = new Set([
  'AccessDeniedException',
  'BlockedException',
  'ClientException',
  'ClusterNotFoundException',
  'InvalidParameterException',
  'PlatformTaskDefinitionIncompatibilityException',
  'PlatformUnknownException',
  'UnsupportedFeatureException',
]);

function failureMessage(failures: RunTaskFailure[]): string {
  return failures
    .map((failure) => {
      const detail = failure.detail ? ` (${failure.detail})` : '';
      return `${failure.reason ?? 'unknown'}${detail}`;
    })
    .join('; ');
}

function classifyResponse(
  response: RunTaskAttempt,
  reconciled: boolean,
  priorAttemptError?: string,
): RunTaskReconciliationResult {
  const taskArn = response.taskArns[0];
  if (taskArn) {
    return { status: 'accepted', taskArn, reconciled };
  }
  const rejection = response.failures.length > 0
    ? `RunTask failures: ${failureMessage(response.failures)}`
    : 'RunTask returned no task ARN';
  return {
    status: 'rejected',
    errorMessage: priorAttemptError
      ? `Initial RunTask attempt was ambiguous (${priorAttemptError}); ` +
        `idempotent retry was definitive: ${rejection}`
      : rejection,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function stringProperty(
  record: Record<string, unknown> | null,
  property: string,
): string | undefined {
  const value = record?.[property];
  return typeof value === 'string' && value.length > 0
    ? sanitizeDiagnostic(value)
    : undefined;
}

function numberProperty(
  record: Record<string, unknown> | null,
  property: string,
): number | undefined {
  const value = record?.[property];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function formatRunTaskError(error: unknown): string {
  const record = asRecord(error);
  const metadata = asRecord(record?.$metadata);
  const name =
    stringProperty(record, 'name') ??
    (error instanceof Error
      ? sanitizeDiagnostic(error.name)
      : 'UnknownError');
  const message =
    stringProperty(record, 'message') ??
    (error instanceof Error
      ? sanitizeDiagnostic(error.message)
      : sanitizeDiagnostic(String(error)));
  const attributes = [
    numberProperty(metadata, 'httpStatusCode') !== undefined
      ? `HTTP ${numberProperty(metadata, 'httpStatusCode')}`
      : undefined,
    stringProperty(metadata, 'requestId')
      ? `request ${stringProperty(metadata, 'requestId')}`
      : undefined,
    numberProperty(metadata, 'attempts') !== undefined
      ? `SDK attempts ${numberProperty(metadata, 'attempts')}`
      : undefined,
    numberProperty(metadata, 'totalRetryDelay') !== undefined
      ? `SDK retry delay ${numberProperty(metadata, 'totalRetryDelay')}ms`
      : undefined,
  ].filter((attribute): attribute is string => !!attribute);
  const heading = attributes.length > 0
    ? `${name} [${attributes.join(', ')}]`
    : name;
  return (message && message !== name ? `${heading}: ${message}` : heading)
    .slice(0, MAX_FORMATTED_ERROR_LENGTH);
}

function classifyThrownRunTask(error: unknown): ThrownRunTaskResult {
  const record = asRecord(error);
  const metadata = asRecord(record?.$metadata);
  const name =
    stringProperty(record, 'name') ??
    (error instanceof Error ? error.name : 'UnknownError');
  const errorMessage = formatRunTaskError(error);

  const httpStatusCode = numberProperty(metadata, 'httpStatusCode');
  if (
    DEFINITIVE_RUN_TASK_ERRORS.has(name) ||
    (httpStatusCode !== undefined &&
      httpStatusCode >= 400 &&
      httpStatusCode < 500)
  ) {
    return {
      status: 'rejected',
      errorMessage: `RunTask request rejected: ${errorMessage}`,
    };
  }

  return {
    status: 'ambiguous',
    errorMessage,
  };
}

async function findStoppedTask(
  dependencies: RunTaskLookupDependencies,
): Promise<string | undefined> {
  let nextToken: string | undefined;
  const seenTokens = new Set<string>();

  for (let pageNumber = 0; pageNumber < MAX_STOPPED_TASK_PAGES; pageNumber += 1) {
    const page = await dependencies.listStoppedTasks(nextToken);
    if (page.taskArns.length > 0) {
      const descriptions = await dependencies.describeTasks(page.taskArns);
      const match = descriptions.find(
        (task) =>
          task.startedBy === dependencies.startedBy &&
          typeof task.taskArn === 'string' &&
          task.taskArn.length > 0,
      );
      if (match?.taskArn) return match.taskArn;
    }

    if (!page.nextToken) return undefined;
    if (seenTokens.has(page.nextToken)) {
      throw new Error('ListTasks returned a repeated pagination token');
    }
    seenTokens.add(page.nextToken);
    nextToken = page.nextToken;
  }

  throw new Error(
    `Stopped-task lookup exceeded ${MAX_STOPPED_TASK_PAGES} pages`,
  );
}

/**
 * Find the exact task for a startedBy marker across live and recently stopped
 * ECS tasks. Empty means "not visible in this lookup"; callers decide whether
 * their elapsed consistency window makes that terminal.
 */
export async function findRunTaskByStartedBy(
  dependencies: RunTaskLookupDependencies,
): Promise<string | undefined> {
  const running = await dependencies.listRunningTasks();
  if (running[0]) return running[0];
  return findStoppedTask(dependencies);
}

async function findAcceptedTask(
  dependencies: RunTaskReconciliationDependencies,
  attemptErrors: readonly [string, string],
): Promise<RunTaskReconciliationResult> {
  let lookupSucceeded = false;
  let lastLookupError: string | undefined;

  for (const delayMs of RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) await dependencies.wait(delayMs);
    try {
      const taskArn = await findRunTaskByStartedBy(dependencies);
      if (taskArn) {
        return {
          status: 'accepted',
          taskArn,
          reconciled: true,
        };
      }
      lookupSucceeded = true;
      lastLookupError = undefined;
    } catch (error) {
      lastLookupError = formatRunTaskError(error);
    }
  }

  const lookupOutcome = lastLookupError
    ? `Last ECS lookup error: ${lastLookupError}.`
    : lookupSucceeded
      ? 'No task became visible during the bounded ECS lookup; an empty ' +
        'eventually consistent lookup is not proof of rejection.'
      : 'No ECS lookup completed successfully.';
  return {
    status: 'ambiguous',
    errorMessage:
      `RunTask outcome remained ambiguous. ` +
      `Attempt 1: ${attemptErrors[0]}. ` +
      `Attempt 2: ${attemptErrors[1]}. ` +
      lookupOutcome,
  };
}

/**
 * Resolve the unsafe RunTask failure mode where ECS may accept a request even
 * though its HTTP response is lost. AWS documents 4xx responses as definitive
 * client rejections and same-token 5xx/transport retries as idempotent. When
 * both attempts remain uncertain, lookup can prove acceptance but—because ECS
 * is eventually consistent—an empty lookup can never prove rejection.
 */
export async function reconcileRunTaskLaunch(
  dependencies: RunTaskReconciliationDependencies,
): Promise<RunTaskReconciliationResult> {
  let firstAttemptError: string;
  try {
    return classifyResponse(await dependencies.runTask(), false);
  } catch (error) {
    const classified = classifyThrownRunTask(error);
    if (classified.status === 'rejected') return classified;
    firstAttemptError = classified.errorMessage;
  }

  try {
    return classifyResponse(
      await dependencies.runTask(),
      true,
      firstAttemptError,
    );
  } catch (error) {
    const classified = classifyThrownRunTask(error);
    if (classified.status === 'rejected') {
      return {
        status: 'rejected',
        errorMessage:
          `Initial RunTask attempt was ambiguous (${firstAttemptError}); ` +
          `idempotent retry was definitive: ${classified.errorMessage}`,
      };
    }
    return findAcceptedTask(dependencies, [
      firstAttemptError,
      classified.errorMessage,
    ]);
  }
}
