/**
 * Shared helpers for the owner-bound psd-schedules skill.
 *
 * The model runtime does not receive schedule-table, EventBridge Scheduler, or
 * iam:PassRole authority. It sends schedule specifications to the trusted web
 * broker, which derives owner and destination from signed server-side context.
 */

'use strict';

const {
  agentRequestHeaders,
} = require('../_shared/invocation-context');

const APP_BASE_URL = process.env.APP_BASE_URL || '';
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

function fail(message, code = 1) {
  process.stderr.write(`psd-schedules: ${message}\n`);
  process.exit(code);
}

function validateEnv() {
  if (!APP_BASE_URL) fail('APP_BASE_URL environment variable is not set');
}

function rejectLegacyAuthorityArgs(args) {
  const forbidden = [
    'user',
    'owner-email',
    'google-identity',
    'dm-space-name',
    'workspace-prefix',
  ];
  const supplied = forbidden.find((field) =>
    Object.prototype.hasOwnProperty.call(args, field),
  );
  if (supplied) {
    fail(
      `--${supplied} is not accepted. Schedule identity is derived ` +
        'from the signed invocation context.',
    );
  }
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    fail(
      `Invalid timezone "${timezone}". Must be a valid IANA timezone ` +
        '(e.g. America/Los_Angeles, Asia/Tokyo, UTC).',
    );
  }
}

function toSchedulerExpression(raw) {
  const expr = String(raw || '').trim();
  if (!expr) fail('--cron is required');

  if (expr.startsWith('cron(') || expr.startsWith('rate(') || expr.startsWith('at(')) {
    return validateWrappedExpression(expr);
  }

  const parts = expr.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    fail(
      `Invalid cron "${expr}". Expected 5 or 6 fields (got ${parts.length}).`,
    );
  }
  const expanded = parts.length === 6 ? [...parts] : [...parts, '*'];
  const minute = expanded[0];
  if (minute === '*' || minute === '*/1') {
    fail('Every-minute cron is not allowed. Minimum interval is 5 minutes.');
  }
  const domSpecified = expanded[2] !== '*' && expanded[2] !== '?';
  const dowSpecified = expanded[4] !== '*' && expanded[4] !== '?';
  if (domSpecified && dowSpecified) {
    fail('Cannot specify both day-of-month and day-of-week.');
  }
  if (dowSpecified) expanded[2] = '?';
  else expanded[4] = '?';
  return `cron(${expanded.join(' ')})`;
}

function validateWrappedExpression(expr) {
  const cronMatch = expr.match(/^cron\((.+)\)$/);
  if (cronMatch) {
    const fields = cronMatch[1].trim().split(/\s+/);
    if (fields.length !== 6) fail('cron() must have exactly 6 fields');
    if (fields[0] === '*' || fields[0] === '*/1') {
      fail('Every-minute cron is not allowed. Minimum interval is 5 minutes.');
    }
    return expr;
  }
  const rateMatch = expr.match(
    /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/,
  );
  if (rateMatch) {
    const count = Number.parseInt(rateMatch[1], 10);
    if (
      (rateMatch[2] === 'minute' || rateMatch[2] === 'minutes') &&
      count < 5
    ) {
      fail('Minimum rate interval is 5 minutes.');
    }
    return expr;
  }
  if (/^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/.test(expr)) {
    return expr;
  }
  fail(`Invalid expression "${expr}".`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function requestScheduleOperation(payload) {
  validateEnv();
  const response = await fetch(
    `${APP_BASE_URL.replace(/\/+$/, '')}/api/agent/schedules`,
    {
      method: 'POST',
      headers: agentRequestHeaders(),
      body: JSON.stringify(payload),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Schedule broker failed (${response.status}): ${body.error || 'unknown error'}`,
    );
  }
  return body;
}

module.exports = {
  DEFAULT_TIMEZONE,
  fail,
  validateEnv,
  rejectLegacyAuthorityArgs,
  validateTimezone,
  toSchedulerExpression,
  parseArgs,
  emit,
  requestScheduleOperation,
};
