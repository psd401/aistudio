#!/usr/bin/env node

'use strict';

const {
  fail,
  rejectLegacyAuthorityArgs,
  parseArgs,
  emit,
  requestScheduleOperation,
} = require('./common');

function renderLastRunStatus(result) {
  if (!result || !Array.isArray(result.schedules)) return result;
  return {
    ...result,
    schedules: result.schedules.map((schedule) => {
      if (!schedule || typeof schedule !== 'object') return schedule;
      return {
        ...schedule,
        lastRunStatus:
          typeof schedule.lastRunAt === 'string'
            ? schedule.lastRunStatus || 'unknown'
            : schedule.lastRunStatus === 'unknown'
              ? 'unknown'
              : 'never run',
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
