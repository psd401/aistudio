#!/usr/bin/env node
/**
 * psd-failure-report/report.js
 *
 * Agent self-reports a semantic failure. Writes to agent_failures via RDS Data
 * API. Best-effort: emits structured CloudWatch line either way so failures are
 * recoverable even when the DB is unreachable.
 *
 * Usage:
 *   node report.js \
 *     --user <caller-email> \
 *     --reason <category> \
 *     --details "<what went wrong>" \
 *     [--tool <tool-name>] \
 *     [--user-facing true|false]
 */

'use strict';

const {
  RDSDataClient,
  ExecuteStatementCommand,
} = require('@aws-sdk/client-rds-data');

const REGION = process.env.AWS_REGION || 'us-east-1';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const SESSION_ID = process.env.AGENT_SESSION_ID || process.env.SESSION_ID || null;

const VALID_REASONS = new Set([
  'missing_credentials',
  'tool_error',
  'tool_unavailable',
  'data_not_found',
  'ambiguous_request',
  'task_incomplete',
  'other',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2).replace(/-/g, '_');
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

function truncate(s, max) {
  if (typeof s !== 'string') return null;
  return s.length <= max ? s : s.slice(0, max);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    process.stdout.write(
      'Usage: report.js --user EMAIL --reason CATEGORY --details TEXT [--tool NAME] [--user-facing true|false]\n',
    );
    return;
  }

  if (!args.user || !EMAIL_RE.test(args.user)) {
    fail('--user is required and must be a valid email');
  }
  if (!args.reason || typeof args.reason !== 'string') {
    fail('--reason is required (one of: ' + [...VALID_REASONS].join(', ') + ')');
  }
  if (!VALID_REASONS.has(args.reason)) {
    fail(`--reason must be one of: ${[...VALID_REASONS].join(', ')}`);
  }
  if (!args.details || typeof args.details !== 'string') {
    fail('--details is required (short description of what went wrong)');
  }

  const tool = typeof args.tool === 'string' ? args.tool : null;
  const userFacing =
    typeof args.user_facing === 'string'
      ? args.user_facing.toLowerCase() !== 'false'
      : true;

  const errorClass = truncate(args.reason, 128);
  const errorMessage = truncate(args.details, 4000);
  const context = JSON.stringify({
    tool,
    user_facing: userFacing,
    self_reported: true,
  });

  // Always emit a structured CloudWatch line first so the failure is
  // recoverable even when the DB write fails.
  process.stderr.write(
    'AGENT_FAILURE_RECORD ' +
      JSON.stringify({
        source: 'agent_self_report',
        severity: 'warn',
        user_id: args.user,
        session_id: SESSION_ID,
        error_class: errorClass,
        error_message: errorMessage,
        context: { tool, user_facing: userFacing },
      }) +
      '\n',
  );

  if (!DATABASE_RESOURCE_ARN || !DATABASE_SECRET_ARN) {
    emit({ logged: false, reason: 'database_not_configured' });
    return;
  }

  const client = new RDSDataClient({ region: REGION });

  try {
    const resp = await client.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `INSERT INTO agent_failures
                (source, severity, user_id, session_id,
                 error_class, error_message, context, occurred_at)
              VALUES
                ('agent_self_report', 'warn', :user_id, :session_id,
                 :error_class, :error_message, CAST(:context AS jsonb), NOW())
              RETURNING id`,
        parameters: [
          { name: 'user_id', value: { stringValue: args.user } },
          SESSION_ID
            ? { name: 'session_id', value: { stringValue: SESSION_ID } }
            : { name: 'session_id', value: { isNull: true } },
          { name: 'error_class', value: { stringValue: errorClass } },
          { name: 'error_message', value: { stringValue: errorMessage } },
          { name: 'context', value: { stringValue: context } },
        ],
      }),
    );
    const records = resp.records || [];
    let id = null;
    if (records.length > 0 && records[0].length > 0) {
      id = records[0][0].longValue ?? records[0][0].stringValue ?? null;
    }
    emit({ logged: true, failure_id: id });
  } catch (err) {
    process.stderr.write(`agent_failures insert failed: ${err.message}\n`);
    emit({ logged: false, reason: 'database_error' });
  }
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err && err.stack ? err.stack : err}\n`);
  // Skill must not crash the agent; exit 0 with logged:false rather than non-zero.
  emit({ logged: false, reason: 'unexpected_error' });
});
