#!/usr/bin/env node
/**
 * run.js — psd-data skill entrypoint.
 *
 * Subcommands mirror the 8 tools exposed by psd-data-mcp. Every subcommand
 * requires `--user <caller-email>` so the skill can look up the caller's
 * Cognito refresh token in Secrets Manager.
 *
 * Usage:
 *   node run.js tables --user <email> [--detailed]
 *   node run.js schema --user <email> --table <name|json-array>
 *   node run.js permissions --user <email> --table <name|json-array>
 *   node run.js query --user <email> --reason <text> --sql <sql>
 *                     [--export] [--view-results] [--limit N] [--offset N]
 *   node run.js lesson-save --user <email> --lesson <text> --tables <json>
 *                           --task <text> --category <enum>
 *                           --significance <1-10> [--columns <json>]
 *   node run.js lesson-delete --user <email> --uuid <id>
 *   node run.js lesson-check --user <email> --task <text> --tables <json>
 *                            [--columns <json>]
 *   node run.js lesson-rate --user <email> --id <int>
 *                           --rating <helpful|unhelpful> [--feedback <text>]
 *
 * Exit codes:
 *   0   success (JSON-RPC result printed to stdout)
 *   1   usage / config error
 *   2   internal / unexpected
 *   10  needs-auth (no stored refresh token, or it's been revoked)
 *   12  upstream MCP error (JSON-RPC error or non-2xx without auth/perm meaning)
 *   13  forbidden (HTTP 403 — user not in userpermissions table)
 *   14  rate-limited (HTTP 429)
 */

'use strict';

const {
  fail,
  parseArgs,
  validateUserEmail,
  callMcp,
  findUnqualifiedNumericCasts,
} = require('./common');

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> --user <email> [...]',
      '',
      'Typed subcommands (validated args, recommended for known tools):',
      '  tables [--detailed]',
      '  schema --table <name|json-array>',
      '  permissions --table <name|json-array>',
      '  query --reason <text> --sql <sql> [--export] [--view-results] [--limit N] [--offset N]',
      '  lesson-save --lesson <text> --tables <json> --task <text> --category <enum> --significance <1-10> [--columns <json>]',
      '  lesson-delete --uuid <id>',
      '  lesson-check --task <text> --tables <json> [--columns <json>]',
      '  lesson-rate --id <int> --rating <helpful|unhelpful> [--feedback <text>]',
      '',
      'Discovery / passthrough (use when a typed subcommand does not exist):',
      '  list                              MCP tools/list — names + descriptions + inputSchema',
      '  call --tool <name> --args <json>  MCP tools/call passthrough for any tool',
      '',
    ].join('\n')
  );
}

function parseJsonArg(name, raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`--${name} must be valid JSON: ${err.message}`);
    return undefined; // unreachable
  }
}

function parseIntArg(name, raw) {
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    fail(`--${name} must be an integer`);
  }
  return n;
}

function requireArg(args, name) {
  if (args[name] === undefined || args[name] === true || args[name] === '') {
    fail(`--${name.replace(/_/g, '-')} is required`);
  }
  return args[name];
}

// Shared by both the typed `query` subcommand and the `call` passthrough
// (when it targets `query_data` directly) so a bare `CAST(x AS NUMERIC)`
// can't slip through via the passthrough route — see SKILL.md's
// "Hardcoded subcommands are a convenience, not a fence" note.
function checkSqlOrFail(sql) {
  const unqualifiedCasts = findUnqualifiedNumericCasts(sql);
  if (unqualifiedCasts.length > 0) {
    fail(
      `SQL contains unqualified NUMERIC/DECIMAL cast(s): ${unqualifiedCasts.join(', ')}. ` +
        'The psd-data-mcp server rejects casts without explicit precision, which drops ' +
        'that column from the result set (and any CSV export). Add precision, e.g. ' +
        'CAST(col AS NUMERIC(10,2)) or col::NUMERIC(10,2), then retry.'
    );
  }
}

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    usage();
    process.exit(0);
  }

  // parseArgs skips argv[0..1]; ours adds argv[2] = subcommand. Shift so
  // parseArgs reads flags starting at index 3.
  const args = parseArgs([process.argv[0], process.argv[1], ...process.argv.slice(3)]);
  if (args.help) {
    usage();
    process.exit(0);
  }

  validateUserEmail(args.user);
  const ownerEmail = args.user;

  switch (subcommand) {
    case 'list': {
      // Discovery — surface the MCP server's current tool catalog so the
      // agent can detect new tools or schema changes without a redeploy.
      await callMcp('tools/list', {}, ownerEmail);
      return;
    }

    case 'call': {
      // Generic passthrough — invoke any MCP tool by name with a
      // JSON-encoded arguments object. Use this when a tool exists on
      // the server but does not yet have a typed subcommand here.
      const toolName = requireArg(args, 'tool');
      const argsRaw = args.args === undefined || args.args === true ? '{}' : args.args;
      const toolArgs = parseJsonArg('args', argsRaw);
      if (toolName === 'query_data' && toolArgs && typeof toolArgs.sql_query === 'string') {
        checkSqlOrFail(toolArgs.sql_query);
      }
      const params = { name: toolName, arguments: toolArgs };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'tables': {
      const params = {
        name: 'list_available_tables',
        arguments: { detailed: !!args.detailed },
      };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'schema': {
      const table = requireArg(args, 'table');
      // Accept a JSON array or a bare name.
      const arg =
        typeof table === 'string' && table.trim().startsWith('[')
          ? parseJsonArg('table', table)
          : table;
      const params = {
        name: 'inspect_table_schema',
        arguments: { table_name: arg },
      };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'permissions': {
      const table = requireArg(args, 'table');
      const arg =
        typeof table === 'string' && table.trim().startsWith('[')
          ? parseJsonArg('table', table)
          : table;
      const params = {
        name: 'view_table_permissions',
        arguments: { table_name: arg },
      };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'query': {
      const reason = requireArg(args, 'reason');
      const sql = requireArg(args, 'sql');
      checkSqlOrFail(sql);
      const toolArgs = { reason, sql_query: sql };
      // parseArgs returns the string "false" for `--flag false`, which is
      // truthy. Explicitly convert to boolean so --export false / --view-results false work.
      if (args['export'] !== undefined) toolArgs.export = args['export'] === true || args['export'] === 'true';
      if (args.view_results !== undefined) toolArgs.view_results = args.view_results === true || args.view_results === 'true';
      const limit = parseIntArg('limit', args.limit);
      const offset = parseIntArg('offset', args.offset);
      if (limit !== undefined) toolArgs.limit = limit;
      if (offset !== undefined) toolArgs.offset = offset;
      const params = { name: 'query_data', arguments: toolArgs };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'lesson-save': {
      const lesson = requireArg(args, 'lesson');
      const tablesInvolved = parseJsonArg('tables', requireArg(args, 'tables'));
      const taskContext = requireArg(args, 'task');
      const category = requireArg(args, 'category');
      const significance = parseIntArg('significance', requireArg(args, 'significance'));
      const columnsInvolved =
        args.columns !== undefined ? parseJsonArg('columns', args.columns) : undefined;
      const toolArgs = {
        lesson,
        tables_involved: tablesInvolved,
        task_context: taskContext,
        category,
        significance,
      };
      if (columnsInvolved !== undefined) toolArgs.columns_involved = columnsInvolved;
      const params = { name: 'save_lesson', arguments: toolArgs };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'lesson-delete': {
      const uuid = requireArg(args, 'uuid');
      const params = {
        name: 'delete_lesson',
        arguments: { lesson_uuid: uuid },
      };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'lesson-check': {
      const task = requireArg(args, 'task');
      const tables = parseJsonArg('tables', requireArg(args, 'tables'));
      const toolArgs = { task_description: task, tables };
      if (args.columns !== undefined) {
        toolArgs.columns = parseJsonArg('columns', args.columns);
      }
      const params = { name: 'check_lessons', arguments: toolArgs };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    case 'lesson-rate': {
      const id = parseIntArg('id', requireArg(args, 'id'));
      const rating = requireArg(args, 'rating');
      if (rating !== 'helpful' && rating !== 'unhelpful') {
        fail('--rating must be "helpful" or "unhelpful"');
      }
      const toolArgs = { lesson_id: id, rating };
      if (rating === 'unhelpful') {
        toolArgs.feedback = requireArg(args, 'feedback');
      } else if (args.feedback !== undefined && args.feedback !== true) {
        toolArgs.feedback = args.feedback;
      }
      const params = { name: 'rate_lesson', arguments: toolArgs };
      await callMcp('tools/call', params, ownerEmail);
      return;
    }

    default:
      fail(`Unknown subcommand: ${subcommand}. Run with --help to see options.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err), 2);
  });
}

module.exports = { main };
