#!/usr/bin/env node
/**
 * psd-plaud — read the caller's Plaud voice recordings via Plaud's hosted MCP
 * server, authenticated per-user with an OAuth refresh token.
 *
 * Usage:
 *   node run.js <subcommand> [flags]
 *
 * Subcommands (map to Plaud MCP tools):
 *   list      [--page N] [--page-size N] [--query kw] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   search    --query <keyword>            (alias for list with a keyword)
 *   file      --id <id>                    (recording metadata + audio URL)
 *   digest    --id <id> [--profiles a,b] [--output ...] [--length ...]
 *                                          (DEFAULT for content: records-safe
 *                                          summary; the raw transcript is
 *                                          summarized in-skill and never enters
 *                                          the agent context/logs)
 *   transcript --id <id>                   (RAW transcript — explicit, sensitive)
 *   summary   --id <id>                    (Plaud's own AI note for the recording)
 *   whoami                                 (current Plaud account)
 *   tools                                  (introspect the live MCP tool schema)
 *
 * Exit codes: 0 ok · 1 usage · 10 needs-auth · 12 mcp/upstream error · 14 rate-limited.
 *
 * NOTE: tool names are list_files/get_file/get_note/get_transcript/
 * get_current_user. get_file/get_note/get_transcript take the recording id
 * under the `file_id` argument key (confirmed live against Plaud's MCP
 * server) — list_files takes no id. Run `tools` if a call ever fails on an
 * argument to re-confirm the live schema.
 */

'use strict';

const {
  fail, rejectAuthorityArgs, parseArgs, callTool, digestRecording, listTools,
} = require('./common');

function requireRecordingId(args, command) {
  if (!args.id || args.id === true) {
    fail(`${command} requires --id <recording-id>`);
  }
  return args.id;
}

function listArguments(args, subcommand) {
  const toolArgs = {};
  const keyword = args.query || args.keyword;
  if (keyword && keyword !== true) toolArgs.keyword = keyword;
  if (args.page && args.page !== true) toolArgs.page = Number(args.page);
  if (args.page_size && args.page_size !== true) {
    toolArgs.page_size = Number(args.page_size);
  }
  if (args.from && args.from !== true) toolArgs.from = args.from;
  if (args.to && args.to !== true) toolArgs.to = args.to;
  if (subcommand === 'search' && !toolArgs.keyword) {
    fail('search requires --query <keyword>');
  }
  return toolArgs;
}

async function runPlaudCommand(subcommand, args) {
  if (subcommand === 'whoami') return callTool('get_current_user', {});
  if (subcommand === 'tools') return listTools();
  if (subcommand === 'list' || subcommand === 'search') {
    return callTool('list_files', listArguments(args, subcommand));
  }
  if (subcommand === 'file') {
    return callTool('get_file', {
      file_id: requireRecordingId(args, subcommand),
    });
  }
  if (subcommand === 'digest') {
    return digestRecording(requireRecordingId(args, subcommand), {
      profiles: typeof args.profiles === 'string' ? args.profiles : undefined,
      output: typeof args.output === 'string' ? args.output : undefined,
      length: typeof args.length === 'string' ? args.length : undefined,
    });
  }
  if (subcommand === 'transcript') {
    return callTool('get_transcript', {
      file_id: requireRecordingId(args, subcommand),
    });
  }
  if (subcommand === 'summary') {
    return callTool('get_note', {
      file_id: requireRecordingId(args, subcommand),
    });
  }
  fail(
    `Unknown subcommand "${subcommand}". Try: list, search, file, digest, transcript, summary, whoami, tools.`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  // The subcommand is the first positional. parseArgs consumes flag values, so
  // args._[0] is the real subcommand (not a --flag's value).
  const sub = args._[0];

  if (args.help || !sub) {
    process.stdout.write(
      'Usage: run.js <list|search|file|digest|transcript|summary|whoami|tools> [flags]\n'
    );
    process.exit(sub ? 0 : 1);
  }

  rejectAuthorityArgs(args);
  await runPlaudCommand(sub, args);
}

if (require.main === module) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

module.exports = { main };
