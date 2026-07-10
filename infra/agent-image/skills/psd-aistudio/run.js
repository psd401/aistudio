#!/usr/bin/env node
/**
 * run.js — psd-aistudio skill entrypoint (Issue #1100).
 *
 * Gives the agent a LIVE, always-current view of what AI Studio can do by
 * calling the `describe_capabilities` meta-tool on AI Studio's existing
 * `/api/mcp` endpoint. Read-only: it discovers capabilities, it does not invoke
 * app actions (the action-executing passthrough is deferred to the MCP
 * action-tool work, which brings per-user auth — see SKILL.md).
 *
 * Usage:
 *   node run.js capabilities [--section actions|features|scopes|all]
 *                            [--surface mcp|ai_sdk|rest|internal] [--query <text>]
 *   node run.js list         # raw MCP tools/list (names + inputSchema)
 *
 * Exit codes:
 *   0   success (JSON result printed to stdout)
 *   1   usage / config error
 *   2   internal / unexpected
 *   11  unauthorized (API key missing/invalid or lacks platform:read)
 *   12  upstream MCP error (JSON-RPC error, e.g. insufficient scope) or network
 *   14  rate-limited
 */

'use strict';

const { fail, parseArgs, callMcp } = require('./common');

const SECTIONS = ['actions', 'features', 'scopes', 'all'];
const SURFACES = ['mcp', 'ai_sdk', 'rest', 'internal'];

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> [...]',
      '',
      'Subcommands (read-only):',
      '  capabilities [--section actions|features|scopes|all]',
      '               [--surface mcp|ai_sdk|rest|internal] [--query <text>]',
      '      Live catalog of what AI Studio can do — invocable actions (with the',
      '      scope each needs + whether the agent can invoke it over MCP),',
      '      role-gated UI features to steer users toward, and a scope reference.',
      '',
      '  list',
      '      Raw MCP tools/list — every tool name, description, and inputSchema the',
      '      key can see. Use when you want the exact wire schema of a tool.',
      '',
    ].join('\n')
  );
}

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    usage();
    process.exit(0);
  }

  // parseArgs reads flags starting at argv index 3 (after the subcommand).
  const args = parseArgs([
    process.argv[0],
    process.argv[1],
    ...process.argv.slice(3),
  ]);
  if (args.help) {
    usage();
    process.exit(0);
  }

  switch (subcommand) {
    case 'capabilities': {
      const toolArgs = {};
      if (args.section !== undefined && args.section !== true) {
        if (!SECTIONS.includes(args.section)) {
          fail(`--section must be one of: ${SECTIONS.join(', ')}`);
        }
        toolArgs.section = args.section;
      }
      if (args.surface !== undefined && args.surface !== true) {
        if (!SURFACES.includes(args.surface)) {
          fail(`--surface must be one of: ${SURFACES.join(', ')}`);
        }
        toolArgs.surface = args.surface;
      }
      if (args.query !== undefined && args.query !== true) {
        toolArgs.query = args.query;
      }
      await callMcp('tools/call', {
        name: 'describe_capabilities',
        arguments: toolArgs,
      });
      return;
    }

    case 'list': {
      // Raw discovery — the MCP server's current tools/list (scope-filtered to
      // what this key can see). Complements `capabilities` when you need a
      // specific tool's exact inputSchema.
      await callMcp('tools/list', {});
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
