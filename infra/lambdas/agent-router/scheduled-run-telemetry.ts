export interface ScheduledJobContext {
  scheduleId?: string;
  scheduleName?: string;
  userEmail: string;
  sessionId: string;
}

export interface ScheduledJobOutcome {
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  errorMessage?: string;
}

export interface ScheduledRunWrite extends ScheduledJobOutcome {
  userEmail: string;
  scheduleId: string;
  scheduleName?: string;
  sessionId: string;
}

interface ScheduledRunLogger {
  error: (message: string, metadata?: Record<string, unknown>) => void;
}

export type ScheduledRunWriter = (
  record: ScheduledRunWrite,
) => Promise<void>;

/**
 * Append the terminal row for a cron-promoted job. Interactive promotions have
 * no scheduleId and remain on the router's ordinary telemetry path.
 *
 * Telemetry cannot be allowed to turn a delivered background result into a
 * retry, so writer failures are loud but intentionally non-throwing.
 */
export async function recordScheduledJobTerminal(
  job: ScheduledJobContext,
  outcome: ScheduledJobOutcome,
  writer: ScheduledRunWriter,
  log: ScheduledRunLogger,
): Promise<void> {
  if (!job.scheduleId) return;
  try {
    await writer({
      userEmail: job.userEmail,
      scheduleId: job.scheduleId,
      ...(job.scheduleName ? { scheduleName: job.scheduleName } : {}),
      sessionId: job.sessionId,
      ...outcome,
      ...(outcome.errorMessage
        ? { errorMessage: outcome.errorMessage.slice(0, 4000) }
        : {}),
    });
  } catch (error) {
    log.error('Failed to record terminal scheduled job run', {
      scheduleId: job.scheduleId,
      status: outcome.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
