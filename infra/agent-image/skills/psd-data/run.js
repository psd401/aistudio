#!/usr/bin/env node
/**
 * run.js — psd-data skill entrypoint.
 *
 * Subcommands mirror the tools exposed by psd-data-mcp. The caller identity
 * comes only from the signed invocation context.
 *
 * Usage:
 *   node run.js tables [--detailed]
 *   node run.js schema --table <name|json-array>
 *   node run.js permissions --table <name|json-array>
 *   node run.js query --reason <text> --sql <sql>
 *                     [--export] [--view-results] [--limit N] [--offset N]
 *   node run.js lesson-save --lesson <text> --tables <json>
 *                           --task <text> --category <enum>
 *                           --significance <1-10> [--columns <json>]
 *   node run.js lesson-delete --uuid <id>
 *   node run.js lesson-check --task <text> --tables <json>
 *                            [--columns <json>]
 *   node run.js lesson-rate --id <int>
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
  rejectAuthorityArgs,
  callMcp,
  findUnqualifiedNumericCasts,
} = require('./common');

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> [...]',
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

function callNamedTool(name, toolArgs) {
  return callMcp('tools/call', { name, arguments: toolArgs });
}

function parseTableArg(args) {
  const table = requireArg(args, 'table');
  return typeof table === 'string' && table.trim().startsWith('[')
    ? parseJsonArg('table', table)
    : table;
}

async function callPassthrough(args) {
  const toolName = requireArg(args, 'tool');
  const argsRaw =
    args.args === undefined || args.args === true ? '{}' : args.args;
  const toolArgs = parseJsonArg('args', argsRaw);
  if (
    toolName === 'query_data' &&
    toolArgs &&
    typeof toolArgs.sql_query === 'string'
  ) {
    checkSqlOrFail(toolArgs.sql_query);
  }
  await callNamedTool(toolName, toolArgs);
}

async function queryData(args) {
  const reason = requireArg(args, 'reason');
  const sql = requireArg(args, 'sql');
  checkSqlOrFail(sql);
  const toolArgs = { reason, sql_query: sql };
  if (args.export !== undefined) {
    toolArgs.export = args.export === true || args.export === 'true';
  }
  if (args.view_results !== undefined) {
    toolArgs.view_results =
      args.view_results === true || args.view_results === 'true';
  }
  const limit = parseIntArg('limit', args.limit);
  const offset = parseIntArg('offset', args.offset);
  if (limit !== undefined) toolArgs.limit = limit;
  if (offset !== undefined) toolArgs.offset = offset;
  await callNamedTool('query_data', toolArgs);
}

async function saveLesson(args) {
  const toolArgs = {
    lesson: requireArg(args, 'lesson'),
    tables_involved: parseJsonArg('tables', requireArg(args, 'tables')),
    task_context: requireArg(args, 'task'),
    category: requireArg(args, 'category'),
    significance: parseIntArg(
      'significance',
      requireArg(args, 'significance')
    ),
  };
  if (args.columns !== undefined) {
    toolArgs.columns_involved = parseJsonArg('columns', args.columns);
  }
  await callNamedTool('save_lesson', toolArgs);
}

async function checkLessons(args) {
  const toolArgs = {
    task_description: requireArg(args, 'task'),
    tables: parseJsonArg('tables', requireArg(args, 'tables')),
  };
  if (args.columns !== undefined) {
    toolArgs.columns = parseJsonArg('columns', args.columns);
  }
  await callNamedTool('check_lessons', toolArgs);
}

async function rateLesson(args) {
  const rating = requireArg(args, 'rating');
  if (rating !== 'helpful' && rating !== 'unhelpful') {
    fail('--rating must be "helpful" or "unhelpful"');
  }
  const toolArgs = {
    lesson_id: parseIntArg('id', requireArg(args, 'id')),
    rating,
  };
  if (rating === 'unhelpful') {
    toolArgs.feedback = requireArg(args, 'feedback');
  } else if (args.feedback !== undefined && args.feedback !== true) {
    toolArgs.feedback = args.feedback;
  }
  await callNamedTool('rate_lesson', toolArgs);
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

  rejectAuthorityArgs(args);

  switch (subcommand) {
    case 'list': {
      // Discovery — surface the MCP server's current tool catalog so the
      // agent can detect new tools or schema changes without a redeploy.
      await callMcp('tools/list', {});
      return;
    }

    case 'call': {
      await callPassthrough(args);
      return;
    }

    case 'tables': {
      await callNamedTool('list_available_tables', {
        detailed: !!args.detailed,
      });
      return;
    }

    case 'schema': {
      await callNamedTool('inspect_table_schema', {
        table_name: parseTableArg(args),
      });
      return;
    }

    case 'permissions': {
      await callNamedTool('view_table_permissions', {
        table_name: parseTableArg(args),
      });
      return;
    }

    case 'query': {
      await queryData(args);
      return;
    }

    case 'lesson-save': {
      await saveLesson(args);
      return;
    }

    case 'lesson-delete': {
      await callNamedTool('delete_lesson', {
        lesson_uuid: requireArg(args, 'uuid'),
      });
      return;
    }

    case 'lesson-check': {
      await checkLessons(args);
      return;
    }

    case 'lesson-rate': {
      await rateLesson(args);
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
