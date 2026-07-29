import { sanitizeDiagnostic } from './log-sanitization';

export interface ScheduledJobContext {
  scheduleId?: string;
  scheduleName?: string;
  scheduledRunId?: string;
  fireKey?: string;
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
  scheduledRunId?: string;
  fireKey?: string;
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
 * Update the per-fire promoted row for a cron-promoted job. Interactive
 * promotions have no scheduleId and remain on the ordinary telemetry path.
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
      ...(job.scheduledRunId
        ? { scheduledRunId: job.scheduledRunId }
        : {}),
      ...(job.fireKey ? { fireKey: job.fireKey } : {}),
      sessionId: job.sessionId,
      ...outcome,
      ...(outcome.errorMessage
        ? { errorMessage: sanitizeDiagnostic(outcome.errorMessage, 4000) }
        : {}),
    });
  } catch (error) {
    log.error('Failed to record terminal scheduled job run', {
      scheduleId: job.scheduleId,
      status: outcome.status,
      error: sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}
