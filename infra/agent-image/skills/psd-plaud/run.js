#!/usr/bin/env node
/**
 * psd-plaud — read the caller's Plaud voice recordings via Plaud's hosted MCP
 * server, authenticated per-user with an OAuth refresh token.
 *
 * Usage:
 *   node run.js --user <email> <subcommand> [flags]
 *
 * Subcommands (map to Plaud MCP tools):
 *   list      [--page N] [--page-size N] [--query kw] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   search    --query <keyword>            (alias for list with a keyword)
 *   file      --id <id>                    (recording metadata + audio URL)
 *   transcript --id <id>                   (full transcript)
 *   summary   --id <id>                    (AI note: summary / action items / topics)
 *   whoami                                 (current Plaud account)
 *   tools                                  (introspect the live MCP tool schema)
 *
 * Exit codes: 0 ok · 1 usage · 10 needs-auth · 12 mcp/upstream error · 14 rate-limited.
 *
 * NOTE: the exact MCP tool names/arg keys are the documented ones
 * (list_files/get_file/get_note/get_transcript/get_current_user). Run
 * `tools` once after the first user authorizes to confirm arg shapes, then
 * pin them here if they differ.
 */

'use strict';

const {
  fail, validateUserEmail, parseArgs, callTool, listTools,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  // First non-flag token is the subcommand.
  const sub = process.argv.slice(2).find((a) => !a.startsWith('--'));

  if (args.help || !sub) {
    process.stdout.write(
      'Usage: run.js --user <email> <list|search|file|transcript|summary|whoami|tools> [flags]\n'
    );
    process.exit(sub ? 0 : 1);
  }

  const userEmail = args.user;
  validateUserEmail(userEmail);

  switch (sub) {
    case 'whoami':
      await callTool('get_current_user', {}, userEmail);
      break;

    case 'tools':
      await listTools(userEmail);
      break;

    case 'list':
    case 'search': {
      const toolArgs = {};
      const keyword = args.query || args.keyword;
      if (keyword && keyword !== true) toolArgs.keyword = keyword;
      if (args.page && args.page !== true) toolArgs.page = Number(args.page);
      if (args.page_size && args.page_size !== true) toolArgs.page_size = Number(args.page_size);
      if (args.from && args.from !== true) toolArgs.from = args.from;
      if (args.to && args.to !== true) toolArgs.to = args.to;
      if (sub === 'search' && !toolArgs.keyword) fail('search requires --query <keyword>');
      await callTool('list_files', toolArgs, userEmail);
      break;
    }

    case 'file': {
      if (!args.id || args.id === true) fail('file requires --id <recording-id>');
      await callTool('get_file', { id: args.id }, userEmail);
      break;
    }

    case 'transcript': {
      if (!args.id || args.id === true) fail('transcript requires --id <recording-id>');
      await callTool('get_transcript', { id: args.id }, userEmail);
      break;
    }

    case 'summary': {
      if (!args.id || args.id === true) fail('summary requires --id <recording-id>');
      await callTool('get_note', { id: args.id }, userEmail);
      break;
    }

    default:
      fail(`Unknown subcommand "${sub}". Try: list, search, file, transcript, summary, whoami, tools.`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
