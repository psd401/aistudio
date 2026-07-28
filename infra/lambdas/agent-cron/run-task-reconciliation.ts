export interface RunTaskFailure {
  reason?: string;
  detail?: string;
}

export interface RunTaskAttempt {
  taskArns: string[];
  failures: RunTaskFailure[];
}

export interface RunTaskReconciliationDependencies {
  runTask: () => Promise<RunTaskAttempt>;
  listTasks: (
    desiredStatus: 'RUNNING' | 'STOPPED',
  ) => Promise<string[]>;
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

const RECONCILIATION_DELAYS_MS = [0, 250, 750, 1_500, 2_500] as const;

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
): RunTaskReconciliationResult {
  if (response.failures.length > 0) {
    return {
      status: 'rejected',
      errorMessage: `RunTask failures: ${failureMessage(response.failures)}`,
    };
  }
  const taskArn = response.taskArns[0];
  return taskArn
    ? { status: 'accepted', taskArn, reconciled }
    : {
        status: 'rejected',
        errorMessage: 'RunTask returned no task ARN',
      };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findAcceptedTask(
  dependencies: RunTaskReconciliationDependencies,
): Promise<RunTaskReconciliationResult> {
  let finalRoundSucceeded = false;
  let lastError = 'unknown reconciliation error';

  for (const delayMs of RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) await dependencies.wait(delayMs);
    try {
      const running = await dependencies.listTasks('RUNNING');
      if (running[0]) {
        return {
          status: 'accepted',
          taskArn: running[0],
          reconciled: true,
        };
      }
      const stopped = await dependencies.listTasks('STOPPED');
      if (stopped[0]) {
        return {
          status: 'accepted',
          taskArn: stopped[0],
          reconciled: true,
        };
      }
      finalRoundSucceeded = true;
    } catch (error) {
      finalRoundSucceeded = false;
      lastError = errorDetail(error);
    }
  }

  return finalRoundSucceeded
    ? {
        status: 'rejected',
        errorMessage:
          'RunTask failed after an idempotent retry and no task was found',
      }
    : {
        status: 'ambiguous',
        errorMessage:
          `RunTask outcome remained ambiguous: ${lastError}`,
      };
}

/**
 * Resolve the only unsafe RunTask failure mode: ECS may accept a request even
 * when its HTTP response is lost. Retry the identical client-token request,
 * then reconcile both running and recently stopped tasks before deciding that
 * a launch was rejected.
 */
export async function reconcileRunTaskLaunch(
  dependencies: RunTaskReconciliationDependencies,
): Promise<RunTaskReconciliationResult> {
  try {
    return classifyResponse(await dependencies.runTask(), false);
  } catch {
    try {
      return classifyResponse(await dependencies.runTask(), true);
    } catch {
      return findAcceptedTask(dependencies);
    }
  }
}
