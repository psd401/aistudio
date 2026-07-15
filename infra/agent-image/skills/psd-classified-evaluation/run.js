#!/usr/bin/env node
/**
 * psd-classified-evaluation — conversational PSD Classified Performance
 * Evaluation over the PSD Agent Gateway (n8n MCP Server Trigger, SSE).
 *
 * Subcommands (each opens its own one-shot SSE session):
 *   schema
 *       -> get_classified_evaluation_schema (no args): 7 rating categories with
 *          rubric text + the rating scale + recommended flow.
 *   list-employees --user <evaluator-email>
 *       -> list_supervised_employees: the evaluator's identity, their supervised
 *          employees, and the current evaluation year.
 *   submit --user <evaluator-email> (--json <inline> | --json-file <path>)
 *       -> submit_classified_evaluation: forwards employee_email + the 7
 *          rating_* values + optional supervisor_comments. evaluator_email is
 *          bound server-side from --user (never trusted from the JSON payload).
 *          Returns { success, envelopeId, title, supervisorSigningUrl } or
 *          { success:false, error }.
 *
 * Output contract (see SKILL.md):
 *   exit 0  — stdout is the tool's JSON payload. Pass through.
 *   exit 2  — bad_args: malformed invocation.
 *   exit 11 — not-configured: gateway URL/token missing (contact Kris/IT).
 *   exit 12 — transport: could not reach/complete the gateway SSE round-trip.
 *   exit 13 — gateway-error: the gateway returned a JSON-RPC / tool error.
 *
 * Issue #1230.
 */

'use strict';

const fs = require('node:fs');
const {
  RATING_VALUES,
  callGatewayTool,
  GatewayConfigError,
  GatewayTransportError,
  GatewayToolError,
} = require('./gateway');

// Loose email shape check — the gateway re-derives and verifies people
// authoritatively; this only catches obviously malformed --user values early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message, code = 2, extra = {}) {
  process.stdout.write(JSON.stringify({ status: statusForCode(code), message, ...extra }) + '\n');
  process.exit(code);
}

function statusForCode(code) {
  switch (code) {
    case 11: return 'not-configured';
    case 12: return 'transport-error';
    case 13: return 'gateway-error';
    default: return 'bad-args';
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Minimal long-form argv parser (mirrors the other psd-* skills). */
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i++; }
  }
  return args;
}

function requireUser(args) {
  const user = typeof args.user === 'string' ? args.user.trim() : '';
  if (!user || !EMAIL_RE.test(user)) {
    fail('--user <evaluator-email> is required (the signed-in supervisor, verbatim from the caller header).');
  }
  return user;
}

/** Load the submit arguments object from --json-file (preferred for prose) or --json. */
function loadSubmitArgs(args) {
  let raw;
  if (typeof args.json_file === 'string') {
    try {
      raw = fs.readFileSync(args.json_file, 'utf8');
    } catch (err) {
      fail(`Could not read --json-file ${args.json_file}: ${err.message}`);
    }
  } else if (typeof args.json === 'string') {
    raw = args.json;
  } else {
    fail('submit requires --json <inline> or --json-file <path> with the evaluation payload ' +
      '(employee_email + the 7 rating_* values + optional supervisor_comments).');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`--json/--json-file is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('The evaluation payload must be a JSON object.');
  }
  return parsed;
}

/**
 * Validate + normalize the submit payload. Binds evaluator_email from --user
 * (overriding any value in the JSON), requires employee_email, and checks that
 * every rating_* value is one of the five allowed strings. Returns the final
 * arguments object for the gateway tool.
 */
function buildSubmitArgs(evaluatorEmail, payload) {
  const employeeEmail = typeof payload.employee_email === 'string' ? payload.employee_email.trim() : '';
  if (!employeeEmail || !EMAIL_RE.test(employeeEmail)) {
    fail('The payload must include a valid employee_email (the person being evaluated).');
  }

  const ratingKeys = Object.keys(payload).filter((k) => k.startsWith('rating_'));
  if (ratingKeys.length === 0) {
    fail('The payload must include the rating_* values (one per category from get_classified_evaluation_schema).');
  }
  const invalid = ratingKeys.filter((k) => !RATING_VALUES.includes(payload[k]));
  if (invalid.length > 0) {
    fail(
      `Invalid rating value(s) for: ${invalid.join(', ')}. ` +
        `Each rating must be exactly one of: ${RATING_VALUES.join(' | ')}.`
    );
  }

  // Bind evaluator_email server-side-of-the-skill: the caller's verified email,
  // never a value the model placed in the JSON.
  const finalArgs = { ...payload, evaluator_email: evaluatorEmail, employee_email: employeeEmail };

  if (finalArgs.supervisor_comments != null && typeof finalArgs.supervisor_comments !== 'string') {
    fail('supervisor_comments, if present, must be a string.');
  }
  return finalArgs;
}

async function runTool(toolName, toolArgs) {
  try {
    const { isError, data } = await callGatewayTool(toolName, toolArgs);
    if (isError) {
      emit({ status: 'gateway-error', tool: toolName, message: 'The gateway reported an error for this request.', data });
      process.exit(13);
    }
    emit(data);
  } catch (err) {
    if (err instanceof GatewayConfigError) {
      fail(err.message, 11);
    } else if (err instanceof GatewayToolError) {
      fail(err.message, 13, { rpc_error: err.rpcError });
    } else if (err instanceof GatewayTransportError) {
      fail(err.message, 12);
    } else {
      fail(err instanceof Error ? err.message : String(err), 12);
    }
  }
}

const USAGE = `Usage:
  node run.js schema
  node run.js list-employees --user <evaluator-email>
  node run.js submit --user <evaluator-email> (--json <inline> | --json-file <path>)

Ratings must be one of: ${RATING_VALUES.join(' | ')}`;

async function main() {
  const rawArgs = process.argv.slice(2);
  const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h');
  const sub = rawArgs[0] && !rawArgs[0].startsWith('--') ? rawArgs[0] : null;
  // Parse flags that follow the subcommand.
  const args = parseArgs(['node', 'run.js', ...(sub ? rawArgs.slice(1) : rawArgs)]);
  if (wantsHelp || sub === null) {
    process.stdout.write(USAGE + '\n');
    process.exit(wantsHelp ? 0 : 2);
  }

  switch (sub) {
    case 'schema':
      await runTool('get_classified_evaluation_schema', {});
      break;
    case 'list-employees': {
      const user = requireUser(args);
      await runTool('list_supervised_employees', { evaluator_email: user });
      break;
    }
    case 'submit': {
      const user = requireUser(args);
      const payload = loadSubmitArgs(args);
      const toolArgs = buildSubmitArgs(user, payload);
      await runTool('submit_classified_evaluation', toolArgs);
      break;
    }
    default:
      fail(`Unknown subcommand: ${sub}\n${USAGE}`);
  }
}

// Only run the CLI when invoked directly — requiring this module (unit tests)
// must not trigger main() against the test runner's argv.
if (require.main === module) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err), 12));
}

module.exports = { parseArgs, requireUser, loadSubmitArgs, buildSubmitArgs, statusForCode };
