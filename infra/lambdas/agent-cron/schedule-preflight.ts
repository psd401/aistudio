import type {
  ScheduleLoadResult,
  ScheduleReferenceEvent,
} from './schedule-record';
import type { RunTelemetry } from './run-telemetry';
import { sanitizeDiagnostic } from './diagnostic-sanitization';

interface PreflightLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
}

interface SchedulePreflightOptions {
  requestId: string;
  startedAt: number;
  fireKey?: string;
  load: () => Promise<ScheduleLoadResult>;
  telemetry: RunTelemetry;
  log: PreflightLogger;
}

export interface SchedulePreflightResult {
  loaded: ScheduleLoadResult;
  referencedScheduleId: string;
}

const ALARMED_REJECTION_REASONS = new Set([
  'invalid-reference',
  'owner-mismatch',
  'version-mismatch',
  'invalid-record',
]);

function boundedReferenceValue(
  value: unknown,
  maximumLength: number,
  fallback: string,
): string {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maximumLength)
    : fallback;
}

export async function runSchedulePreflight(
  event: ScheduleReferenceEvent,
  options: SchedulePreflightOptions,
): Promise<SchedulePreflightResult> {
  const referencedScheduleId =
    boundedReferenceValue(event.scheduleId, 64, 'unknown');
  const referencedOwner =
    boundedReferenceValue(event.ownerEmail, 255, 'unknown');
  const referenceSessionId = `${options.requestId}-schedule-reference`;

  let loaded: ScheduleLoadResult;
  try {
    loaded = await options.load();
  } catch (error) {
    const detail = sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    const errorMessage = `Authoritative schedule lookup failed: ${detail}`;
    options.log.error('Authoritative schedule lookup failed', {
      error: detail,
    });
    await options.telemetry.recordPreflightRun(
      {
        fireKey: options.fireKey,
        userEmail: referencedOwner,
        scheduleId: referencedScheduleId,
        sessionId: referenceSessionId,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - options.startedAt,
        status: 'error',
        errorMessage,
      },
      options.log,
    );
    throw error;
  }

  if (!loaded.authorized) {
    const errorMessage = `Schedule reference rejected: ${loaded.reason}`;
    options.log.warn('Schedule reference rejected before invocation', {
      reason: loaded.reason,
      ...(ALARMED_REJECTION_REASONS.has(loaded.reason)
        ? { marker: 'SCHEDULE_REFERENCE_REJECTION' }
        : {}),
    });
    await options.telemetry.recordPreflightRun(
      {
        fireKey: options.fireKey,
        userEmail: referencedOwner,
        scheduleId: referencedScheduleId,
        sessionId: referenceSessionId,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - options.startedAt,
        status: 'skipped',
        errorMessage,
      },
      options.log,
    );
  }

  return { loaded, referencedScheduleId };
}
