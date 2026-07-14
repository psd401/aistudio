#!/usr/bin/env node
/**
 * run.js — psd-aistudio skill entrypoint (Issues #1100, #1223).
 *
 * Two families of subcommands over AI Studio's existing `/api/mcp` endpoint:
 *
 *   DISCOVERY (unchanged, #1100) — works on the shared platform:read key:
 *     capabilities  live capability catalog (describe_capabilities)
 *     list          raw MCP tools/list (scope-filtered to the resolved key)
 *
 *   ACTION (#1223) — each maps 1:1 to an MCP tools/call and runs as the CALLER:
 *     list-assistants   / execute-assistant
 *     search-decisions  / capture-decision / get-decision-graph
 *
 * KEY MODEL (#1223): every subcommand accepts an optional `--user <caller-email>`
 * (from the harness `[caller: Name <email>]` line). When that caller has stored
 * their OWN AI Studio API key (`psd-credentials put --name aistudio_personal_key`)
 * it OVERRIDES the shared key, so the agent can do exactly what that key is scoped
 * for — enforced server-side. With no `--user` / no stored key, the shared,
 * read-only platform:read key is used (discovery works; action subcommands come
 * back insufficient-scope with a hint to store a personal key). Scope is NEVER
 * hardcoded here — this is a thin passthrough.
 *
 * Usage:
 *   node run.js capabilities [--section actions|features|scopes|all]
 *                            [--surface mcp|ai_sdk|rest|internal] [--query <text>] [--user <email>]
 *   node run.js list [--user <email>]
 *   node run.js list-assistants   [--user <email>] [--search <t>] [--status <s>] [--limit N] [--cursor C]
 *   node run.js execute-assistant [--user <email>] --id <n> [--inputs '{"field":"value"}']
 *   node run.js search-decisions  [--user <email>] [--query <t>] [--node-type T] [--node-class C] [--limit N] [--cursor C]
 *   node run.js capture-decision  [--user <email>] --decision "<t>" --decided-by "<t>"
 *                            [--reasoning <t>] [--evidence a,b] [--constraints a,b] [--conditions a,b]
 *                            [--alternatives a,b] [--related-to uuid,uuid] [--agent-id <t>]
 *   node run.js get-decision-graph [--user <email>] --node-id <uuid>
 *
 * Exit codes:
 *   0   success (JSON result printed to stdout; INCLUDES the not_executable draft case)
 *   1   usage / config error
 *   2   internal / unexpected
 *   11  unauthorized (API key missing/invalid, or lacks even platform:read)
 *   12  upstream MCP error (JSON-RPC error incl. insufficient scope, tool-level error, or network)
 *   14  rate-limited
 */

'use strict';

const { fail, emit, parseArgs, callMcp, callTool } = require('./common');

const SECTIONS = ['actions', 'features', 'scopes', 'all'];
const SURFACES = ['mcp', 'ai_sdk', 'rest', 'internal'];

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> [...]',
      '',
      'Every subcommand accepts an optional --user <caller-email>. When that caller',
      'has stored their own AI Studio API key it overrides the shared read-only key,',
      'unlocking exactly what that key is scoped for (enforced server-side).',
      '',
      'Discovery (shared platform:read key is enough):',
      '  capabilities [--section actions|features|scopes|all]',
      '               [--surface mcp|ai_sdk|rest|internal] [--query <text>] [--user <email>]',
      '      Live catalog of what AI Studio can do.',
      '  list [--user <email>]',
      '      Raw MCP tools/list — every tool name, description, and inputSchema the',
      '      resolved key can see.',
      '',
      'Actions (need the caller\'s own scoped key — store it with',
      'psd-credentials put --name aistudio_personal_key):',
      '  list-assistants   [--user <email>] [--search <t>] [--status <s>] [--limit N] [--cursor C]',
      '  execute-assistant [--user <email>] --id <n> [--inputs \'{"field":"value"}\']',
      '      Non-owners can only execute APPROVED assistants; a draft/pending id you',
      '      don\'t own (or a missing id) returns a clean not_executable result',
      '      (exit 0). Needs mcp:execute_assistant (staff + admin).',
      '  search-decisions  [--user <email>] [--query <t>] [--node-type T] [--node-class C]',
      '                    [--limit N] [--cursor C]',
      '  capture-decision  [--user <email>] --decision "<t>" --decided-by "<t>"',
      '                    [--reasoning <t>] [--evidence a,b] [--constraints a,b]',
      '                    [--conditions a,b] [--alternatives a,b] [--related-to uuid,uuid]',
      '                    [--agent-id <t>]   (admin-only: needs mcp:capture_decision)',
      '  get-decision-graph [--user <email>] --node-id <uuid>',
      '',
    ].join('\n')
  );
}

/** Optional string flag; a value-less flag (parseArgs yields `true`) is a usage error. */
function optStr(args, name, label) {
  const v = args[name];
  if (v === undefined) return undefined;
  if (v === true) fail(`--${label} requires a value`);
  return v;
}

/** Required string flag. */
function requireStr(args, name, label) {
  const v = args[name];
  if (v === undefined || v === true || v === '') fail(`--${label} is required`);
  return v;
}

/** Optional positive-integer flag. The MCP handlers ignore a non-number `limit`
 *  (falling back to their default), so a string must be coerced here or it is
 *  silently dropped. */
function optInt(args, name, label) {
  const v = args[name];
  if (v === undefined) return undefined;
  if (v === true) fail(`--${label} requires a value`);
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`--${label} must be a positive integer`);
  }
  return n;
}

/** Parse `--flag a,b,c` into a trimmed string[] (empties dropped); undefined when
 *  absent. A value-less flag is a usage error, not a silently dropped field. */
function parseList(value, label) {
  if (value === undefined) return undefined;
  if (value === true) fail(`--${label} requires a value`);
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** The remediation hint for an insufficient-scope failure — different when the
 *  caller is already on a personal key (re-mint) vs the shared key (store one). */
function scopeHint(keySource, scope) {
  if (keySource === 'personal') {
    return (
      `Your stored AI Studio key lacks ${scope}. Mint a NEW key that includes ` +
      `${scope} in AI Studio (Settings → API Keys) and re-store it: ` +
      `psd-credentials put --name aistudio_personal_key --value sk-...`
    );
  }
  return (
    `You are on the shared, read-only platform:read key, which lacks ${scope}. ` +
    `Store your own AI Studio API key to use this: ` +
    `psd-credentials put --name aistudio_personal_key --value sk-... ` +
    `(the key must include ${scope}).`
  );
}

/**
 * Surface a failed tool call and exit 12 — for BOTH a JSON-RPC error (insufficient
 * scope, unknown tool) and a tool-level isError (validation, node-not-found). An
 * insufficient-scope JSON-RPC error gets the "store/re-mint your key" hint. Never
 * retries, never falls back to another key.
 */
function surfaceToolError(res, toolName) {
  if (res.jsonrpcError) {
    const msg = (res.jsonrpcError && res.jsonrpcError.message) || '';
    const insufficient = /insufficient scope/i.test(msg);
    // Every MCP tool's required scope is `mcp:<toolName>` (see
    // lib/tools/catalog/manifest.ts) — the server is the real enforcement point;
    // this only makes the hint specific.
    emit({
      status: 'mcp-error',
      tool: toolName,
      http_status: res.httpStatus,
      jsonrpc_error: res.jsonrpcError,
      ...(insufficient && { hint: scopeHint(res.keySource, `mcp:${toolName}`) }),
    });
    process.exit(12);
  }
  const text =
    typeof res.payload === 'string' ? res.payload : JSON.stringify(res.payload);
  emit({ status: 'tool-error', tool: toolName, message: text });
  process.exit(12);
}

/** Run a tool and emit its parsed payload on success; delegate any failure to
 *  surfaceToolError (exit 12). Used by every action subcommand except
 *  execute-assistant, which has the special not_executable mapping. */
async function runToolAndEmit(toolName, toolArgs, email) {
  const res = await callTool(toolName, toolArgs, email);
  if (res.jsonrpcError || res.isError) surfaceToolError(res, toolName);
  emit(res.payload);
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

  // Optional caller email — present on every subcommand. Absent → shared key.
  const email = optStr(args, 'user', 'user');

  switch (subcommand) {
    case 'capabilities': {
      const toolArgs = {};
      if (args.section !== undefined) {
        if (args.section === true) fail('--section requires a value');
        if (!SECTIONS.includes(args.section)) {
          fail(`--section must be one of: ${SECTIONS.join(', ')}`);
        }
        toolArgs.section = args.section;
      }
      if (args.surface !== undefined) {
        if (args.surface === true) fail('--surface requires a value');
        if (!SURFACES.includes(args.surface)) {
          fail(`--surface must be one of: ${SURFACES.join(', ')}`);
        }
        toolArgs.surface = args.surface;
      }
      if (args.query !== undefined) {
        if (args.query === true) fail('--query requires a value');
        toolArgs.query = args.query;
      }
      await callMcp(
        'tools/call',
        { name: 'describe_capabilities', arguments: toolArgs },
        email
      );
      return;
    }

    case 'list': {
      // Raw discovery — the MCP server's current tools/list (scope-filtered to
      // what the resolved key can see). Complements `capabilities`.
      await callMcp('tools/list', {}, email);
      return;
    }

    case 'list-assistants': {
      const toolArgs = {};
      const search = optStr(args, 'search', 'search');
      const status = optStr(args, 'status', 'status');
      const limit = optInt(args, 'limit', 'limit');
      const cursor = optStr(args, 'cursor', 'cursor');
      if (search !== undefined) toolArgs.search = search;
      if (status !== undefined) toolArgs.status = status;
      if (limit !== undefined) toolArgs.limit = limit;
      if (cursor !== undefined) toolArgs.cursor = cursor;
      await runToolAndEmit('list_assistants', toolArgs, email);
      return;
    }

    case 'execute-assistant': {
      const assistantId = optInt(args, 'id', 'id');
      if (assistantId === undefined) fail('--id <assistant-id> is required');

      let inputs = {};
      if (args.inputs !== undefined) {
        if (args.inputs === true) fail('--inputs requires a JSON object value');
        try {
          inputs = JSON.parse(args.inputs);
        } catch (err) {
          fail(`--inputs must be valid JSON: ${err.message}`);
        }
        if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
          fail('--inputs must be a JSON object, e.g. \'{"field":"value"}\'');
        }
      }

      const res = await callTool('execute_assistant', { assistantId, inputs }, email);
      if (res.jsonrpcError) surfaceToolError(res, 'execute_assistant');
      if (res.isError) {
        const text =
          typeof res.payload === 'string'
            ? res.payload
            : JSON.stringify(res.payload);
        // A draft/pending assistant the caller doesn't own (or a missing id) is
        // NOT executable via the API — the server masks it as a tool-level error
        // "Record not found in assistant_architects with id: N" (owners and
        // admins CAN execute their own drafts). This is expected, not an
        // upstream failure: report a clean structured result and EXIT 0.
        if (/record not found in assistant_architects/i.test(text)) {
          emit({
            status: 'not_executable',
            assistantId,
            message:
              `Assistant ${assistantId} is not executable via the API — the id ` +
              `does not exist, or it is a draft/pending assistant you don't own ` +
              `(non-owners can only run approved assistants). Run ` +
              `\`list-assistants --status approved\` to find an executable one.`,
          });
          return; // exit 0
        }
        surfaceToolError(res, 'execute_assistant');
      }
      emit(res.payload);
      return;
    }

    case 'search-decisions': {
      const toolArgs = {};
      const query = optStr(args, 'query', 'query');
      const nodeType = optStr(args, 'node_type', 'node-type');
      const nodeClass = optStr(args, 'node_class', 'node-class');
      const limit = optInt(args, 'limit', 'limit');
      const cursor = optStr(args, 'cursor', 'cursor');
      if (query !== undefined) toolArgs.query = query;
      if (nodeType !== undefined) toolArgs.nodeType = nodeType;
      if (nodeClass !== undefined) toolArgs.nodeClass = nodeClass;
      if (limit !== undefined) toolArgs.limit = limit;
      if (cursor !== undefined) toolArgs.cursor = cursor;
      await runToolAndEmit('search_decisions', toolArgs, email);
      return;
    }

    case 'capture-decision': {
      const decision = requireStr(args, 'decision', 'decision');
      const decidedBy = requireStr(args, 'decided_by', 'decided-by');
      const toolArgs = { decision, decidedBy };

      const reasoning = optStr(args, 'reasoning', 'reasoning');
      if (reasoning !== undefined) toolArgs.reasoning = reasoning;

      const evidence = parseList(args.evidence, 'evidence');
      if (evidence !== undefined) toolArgs.evidence = evidence;

      const constraints = parseList(args.constraints, 'constraints');
      if (constraints !== undefined) toolArgs.constraints = constraints;

      const conditions = parseList(args.conditions, 'conditions');
      if (conditions !== undefined) toolArgs.conditions = conditions;

      // Server field is `alternatives_considered`; the CLI flag is `--alternatives`.
      const alternatives = parseList(args.alternatives, 'alternatives');
      if (alternatives !== undefined) toolArgs.alternatives_considered = alternatives;

      const relatedTo = parseList(args.related_to, 'related-to');
      if (relatedTo !== undefined) toolArgs.relatedTo = relatedTo;

      const agentId = optStr(args, 'agent_id', 'agent-id');
      if (agentId !== undefined) toolArgs.agentId = agentId;

      // Success carries completenessScore + optional warnings — surfaced as-is.
      await runToolAndEmit('capture_decision', toolArgs, email);
      return;
    }

    case 'get-decision-graph': {
      const nodeId = requireStr(args, 'node_id', 'node-id');
      await runToolAndEmit('get_decision_graph', { nodeId }, email);
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
