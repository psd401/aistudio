/**
 * Shared helpers for the psd-schedules OpenClaw skill.
 *
 * Reads environment variables injected by the AgentCore runtime at container
 * start. The skill writes EventBridge Scheduler entries directly (no sync
 * Lambda) and maintains DynamoDB metadata in the schedules table.
 *
 * Environment contract (set in agent-platform-stack.ts):
 *   AWS_REGION                    — e.g. us-east-1
 *   SCHEDULES_TABLE               — DynamoDB table name (psd-agent-schedules-<env>)
 *   EVENTBRIDGE_SCHEDULE_GROUP    — schedule group name (psd-agent-<env>)
 *   CRON_LAMBDA_ARN               — target Lambda invoked at fire time
 *   EVENTBRIDGE_ROLE_ARN          — IAM role the scheduler assumes to call the Lambda
 */

'use strict';

const crypto = require('crypto');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION;
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE || '';
const SCHEDULE_GROUP = process.env.EVENTBRIDGE_SCHEDULE_GROUP;
const CRON_LAMBDA_ARN = process.env.CRON_LAMBDA_ARN;
const EVENTBRIDGE_ROLE_ARN = process.env.EVENTBRIDGE_ROLE_ARN;
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

// Module-scope client — instantiated once per Node.js process. Each skill
// invocation is its own process (OpenClaw spawns node per exec), but within
// a single invocation all CRUD helpers share this client so multi-step
// operations like "query then put" reuse one TCP connection.
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
);

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function validateEnv() {
  if (!REGION) fail('AWS_REGION environment variable is not set');
  if (!SCHEDULES_TABLE) fail('SCHEDULES_TABLE environment variable is not set');
  if (!SCHEDULE_GROUP) fail('EVENTBRIDGE_SCHEDULE_GROUP environment variable is not set');
  if (!CRON_LAMBDA_ARN) fail('CRON_LAMBDA_ARN environment variable is not set');
  if (!EVENTBRIDGE_ROLE_ARN) fail('EVENTBRIDGE_ROLE_ARN environment variable is not set');
}

function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
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

/**
 * Accept a 5- or 6-field cron OR an already-wrapped cron(...)/rate(...)/at(...).
 * Normalize to EventBridge Scheduler 6-field cron with the DoM/DoW
 * mutual-exclusion rule applied.
 *
 * Enforces the same cost-safety rules as the AWS sample: no every-minute
 * cron, minimum 5-minute intervals on rate().
 */
function toSchedulerExpression(raw) {
  const expr = String(raw || '').trim();
  if (!expr) fail('--cron is required');

  if (expr.startsWith('cron(') || expr.startsWith('rate(') || expr.startsWith('at(')) {
    return validateWrappedExpression(expr);
  }

  const parts = expr.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    fail(
      `Invalid cron "${expr}". Expected 5 or 6 fields (got ${parts.length}). ` +
        'Format: minute hour day-of-month month day-of-week [year].',
    );
  }

  const [minute, hour, dom, month, dow, year] =
    parts.length === 6 ? parts : [...parts, '*'];

  if (minute === '*' || minute === '*/1') {
    fail('Every-minute cron is not allowed. Minimum interval is 5 minutes.');
  }

  const domSpecified = dom !== '*' && dom !== '?';
  const dowSpecified = dow !== '*' && dow !== '?';

  if (domSpecified && dowSpecified) {
    fail(
      `Invalid cron "${expr}": cannot specify both day-of-month and ` +
        'day-of-week. Use "?" in one of them.',
    );
  }

  let dayOfMonth = dom;
  let dayOfWeek = dow;
  if (dowSpecified) {
    dayOfMonth = '?';
  } else if (domSpecified) {
    dayOfWeek = '?';
  } else {
    dayOfWeek = '?';
  }

  return `cron(${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek} ${year})`;
}

function validateWrappedExpression(expr) {
  const cronMatch = expr.match(/^cron\((.+)\)$/);
  if (cronMatch) {
    const fields = cronMatch[1].trim().split(/\s+/);
    if (fields.length !== 6) {
      fail(
        `cron() must have exactly 6 fields, got ${fields.length}. ` +
          'Format: cron(minute hour day-of-month month day-of-week year).',
      );
    }
    if (fields[0] === '*' || fields[0] === '*/1') {
      fail('Every-minute cron is not allowed. Minimum interval is 5 minutes.');
    }
    return expr;
  }
  const rateMatch = expr.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/);
  if (rateMatch) {
    const unit = rateMatch[2];
    const n = parseInt(rateMatch[1], 10);
    if ((unit === 'minute' || unit === 'minutes') && n < 5) {
      fail('Minimum rate interval is 5 minutes. Use rate(5 minutes) or higher.');
    }
    return expr;
  }
  if (/^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/.test(expr)) {
    return expr;
  }
  fail(
    `Invalid expression "${expr}". Must be cron(...), rate(...), or at(...).`,
  );
}

function generateScheduleId() {
  return crypto.randomUUID();
}

function buildScheduleName(scheduleId) {
  // EventBridge Scheduler caps names at 64 chars. Prefix with environment for
  // human readability. Format: psd-agent-{env}-{scheduleId}.
  // SCHEDULE_GROUP is already psd-agent-{env}; reuse it as the prefix.
  return `${SCHEDULE_GROUP}-${scheduleId}`.substring(0, 64);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Look up a user's googleIdentity + dmSpaceName from the users table via
 * the email-index GSI. Returns null if the user isn't yet in the table
 * (never DM'd the bot). Filters out test/debug records whose
 * googleIdentity doesn't look like a real Google ID.
 */
async function lookupUserByEmail(email) {
  if (!USERS_TABLE || !email) return null;
  const res = await dynamoClient.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email },
  }));
  const items = res.Items || [];
  if (items.length === 0) return null;
  const real = items.find((it) => typeof it.googleIdentity === 'string' && /^users\/\d+/.test(it.googleIdentity));
  const pick = real || items[0];
  return {
    googleIdentity: pick.googleIdentity,
    dmSpaceName: pick.dmSpaceName,
    displayName: pick.displayName,
    workspacePrefix: pick.workspacePrefix,
  };
}

async function putSchedule(item) {
  await dynamoClient.send(new PutCommand({
    TableName: SCHEDULES_TABLE,
    Item: item,
  }));
}

async function getSchedule(userId, scheduleId) {
  const res = await dynamoClient.send(new GetCommand({
    TableName: SCHEDULES_TABLE,
    Key: { userId, scheduleId },
  }));
  return res.Item || null;
}

async function querySchedules(userId) {
  const res = await dynamoClient.send(new QueryCommand({
    TableName: SCHEDULES_TABLE,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
  }));
  return res.Items || [];
}

async function deleteScheduleItem(userId, scheduleId) {
  await dynamoClient.send(new DeleteCommand({
    TableName: SCHEDULES_TABLE,
    Key: { userId, scheduleId },
  }));
}

async function updateScheduleItem(userId, scheduleId, updates) {
  const sets = ['updatedAt = :updatedAt'];
  const values = { ':updatedAt': nowIso() };
  const names = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const ph = `:${key}`;
    const alias = `#${key}`;
    sets.push(`${alias} = ${ph}`);
    values[ph] = value;
    names[alias] = key;
  }
  if (sets.length === 1) return null;
  const res = await dynamoClient.send(new UpdateCommand({
    TableName: SCHEDULES_TABLE,
    Key: { userId, scheduleId },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeValues: values,
    ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
    ConditionExpression: 'attribute_exists(scheduleId)',
    ReturnValues: 'ALL_NEW',
  }));
  return res.Attributes || null;
}

module.exports = {
  REGION,
  SCHEDULES_TABLE,
  USERS_TABLE,
  SCHEDULE_GROUP,
  CRON_LAMBDA_ARN,
  EVENTBRIDGE_ROLE_ARN,
  DEFAULT_TIMEZONE,
  fail,
  validateEnv,
  validateUserEmail,
  validateTimezone,
  toSchedulerExpression,
  generateScheduleId,
  buildScheduleName,
  parseArgs,
  nowIso,
  emit,
  putSchedule,
  getSchedule,
  querySchedules,
  deleteScheduleItem,
  updateScheduleItem,
  lookupUserByEmail,
};
