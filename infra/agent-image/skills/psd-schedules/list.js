#!/usr/bin/env node

'use strict';

const {
  fail,
  rejectLegacyAuthorityArgs,
  parseArgs,
  emit,
  requestScheduleOperation,
} = require('./common');

/**
 * A short, unmissable marker for a schedule that has stopped working (#1890).
 *
 * `lastRunStatus: "error"` on its own reads like a one-off blip, so a job that
 * had been dead for a month looked the same as one that hiccupped once.
 *
 * The VERDICT is the broker's: `schedule.failing` is computed server-side
 * against one threshold in `lib/agent-schedules/run-reader.ts`. This function
 * only renders it. Re-deciding it here against a second local copy of that
 * threshold would mean a server that says "failing" and a skill that says
 * "fine" the moment the two numbers drift, with the skill silently winning.
 */
function failingMarker(schedule) {
  if (schedule.failing !== true) return null;
  const streak = Number(schedule.consecutiveFailures);
  // `consecutiveFailuresCapped` says the count is a FLOOR: the streak reached
  // the bounded number of runs it is measured over. Reporting it as exact
  // would be a number the owner could check and find wrong — and a
  // five-minute schedule saturates it in about two days. Saturation is the
  // server's verdict too, so this does not need its own copy of the bound.
  const atLeast = schedule.consecutiveFailuresCapped === true ? 'at least ' : '';
  const count = Number.isFinite(streak) && streak > 0
    ? `${atLeast}${streak} consecutive failed runs`
    : 'consecutive failed runs';
  return `failing — ${count}; tell the owner and `
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

module.exports = { renderLastRunStatus };

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
