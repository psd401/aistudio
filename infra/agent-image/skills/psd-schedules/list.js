#!/usr/bin/env node

'use strict';

const {
  fail,
  rejectLegacyAuthorityArgs,
  parseArgs,
  emit,
  requestScheduleOperation,
} = require('./common');

/** Consecutive failed runs at which a schedule is called out as failing. */
const FAILING_THRESHOLD = 3;

/**
 * A short, unmissable marker for a schedule that has stopped working (#1890).
 *
 * `lastRunStatus: "error"` on its own reads like a one-off blip, so a job that
 * had been dead for a month looked the same as one that hiccupped once. The
 * marker states the streak, which is what makes it worth acting on.
 */
function failingMarker(schedule) {
  const streak = Number(schedule.consecutiveFailures);
  if (!Number.isFinite(streak) || streak < FAILING_THRESHOLD) return null;
  return `failing — ${streak} consecutive failed runs; tell the owner and `
    + 'check `runs` for the reason';
}

function renderLastRunStatus(result) {
  if (!result || !Array.isArray(result.schedules)) return result;
  return {
    ...result,
    schedules: result.schedules.map((schedule) => {
      if (!schedule || typeof schedule !== 'object') return schedule;
      const marker = failingMarker(schedule);
      return {
        ...schedule,
        lastRunStatus:
          typeof schedule.lastRunAt === 'string'
            ? schedule.lastRunStatus || 'unknown'
            : schedule.lastRunStatus === 'unknown'
              ? 'unknown'
              : 'never run',
        // Always present as a boolean so the agent can filter on it, and only
        // carries the explanatory string when there is something to explain.
        failing: Boolean(marker),
        ...(marker ? { failingReason: marker } : {}),
      };
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('Usage: list.js\n');
    return;
  }
  rejectLegacyAuthorityArgs(args);
  const result = await requestScheduleOperation({ operation: 'list' });
  emit(renderLastRunStatus(result));
}

module.exports = { renderLastRunStatus, FAILING_THRESHOLD };

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
