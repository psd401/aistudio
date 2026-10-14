#!/usr/bin/env node

'use strict';

const {
  DEFAULT_TIMEZONE,
  fail,
  rejectLegacyAuthorityArgs,
  validateTimezone,
  toSchedulerExpression,
  parseArgs,
  emit,
  requestScheduleOperation,
} = require('./common');

/**
 * The refusal fields SKILL.md tells the agent to act on.
 *
 * An allowlist, not the whole body: `requestAgentBroker` deliberately never
 * echoes a parsed response wholesale, because other brokers answer with secret
 * fields alongside the status. These three are the only ones a schedule
 * refusal carries, and the only ones the agent is told to read.
 */
const REFUSAL_FIELDS = ['code', 'existingScheduleId', 'existingScheduleName'];
const REFUSAL_CODES = new Set(['name_conflict', 'possible_duplicate']);

/**
 * The machine-readable half of a 409, or null for any other failure.
 *
 * The broker's prose message reaches the agent either way, but SKILL.md's
 * table tells it to branch on `code` — and `fail()` prints only
 * `error.message`, so without this the documented field never appeared in the
 * agent's transcript at all and it was left guessing which refusal it hit.
 */
function refusalDetail(error) {
  if (!error || typeof error !== 'object' || error.status !== 409) return null;
  const body = error.responseBody;
  if (!body || typeof body !== 'object') return null;
  if (!REFUSAL_CODES.has(body.code)) return null;
  const detail = {};
  for (const field of REFUSAL_FIELDS) {
    if (typeof body[field] === 'string') detail[field] = body[field];
  }
  return detail;
}

/** Prints the refusal code alongside the message so the agent can branch. */
function failWithRefusal(error) {
  const detail = refusalDetail(error);
  const message = error instanceof Error ? error.message : String(error);
  if (detail) {
    fail(`${message}\n${JSON.stringify(detail)}`);
    return;
  }
  fail(message);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: create.js --name <name> --prompt <prompt> --cron <cron> ' +
        '[--timezone <tz>] [--disabled] [--confirm-new]\n\n' +
        'Run list.js first. The broker refuses a second enabled schedule ' +
        'with the same cadence and prompt (code "possible_duplicate") and a ' +
        'name that is already taken (code "name_conflict"), both HTTP 409 ' +
        'with the existing schedule id. Pass --confirm-new only when a ' +
        'second copy is genuinely wanted.\n',
    );
    return;
  }
  rejectLegacyAuthorityArgs(args);
  if (!args.name || args.name === true) fail('--name is required');
  if (!args.prompt || args.prompt === true) fail('--prompt is required');
  if (!args.cron || args.cron === true) fail('--cron is required');
  const timezone =
    typeof args.timezone === 'string' ? args.timezone : DEFAULT_TIMEZONE;
  validateTimezone(timezone);
  toSchedulerExpression(args.cron);
  emit(
    await requestScheduleOperation({
      operation: 'create',
      name: args.name,
      prompt: args.prompt,
      cron: args.cron,
      timezone,
      disabled: args.disabled === true,
      confirmNew: args['confirm-new'] === true,
    }),
  );
}

module.exports = { refusalDetail };

if (require.main === module) {
  main().catch(failWithRefusal);
}
