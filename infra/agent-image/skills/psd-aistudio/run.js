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
 *   ACTION (#1223) — each maps 1:1 to an MCP tools/call and runs as the OWNER:
 *     list-assistants   / execute-assistant
 *     search-decisions  / capture-decision / get-decision-graph
 *
 * IDENTITY MODEL: every operation crosses the local owner-bound broker. The
 * router signs the immutable workspace owner into a replay-bound request proof;
 * AI Studio derives the credential path only from that proof. `--user` remains
 * accepted for CLI compatibility and display-oriented harnesses, but it never
 * selects an owner or credential and is never forwarded to the broker. Provider
 * tokens and API keys stay in the trusted web tier. Scope and resource ACLs are
 * enforced server-side.
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

const {
  fail,
  emit,
  parseArgs,
  callMcp,
  callTool,
  mintConsentUrl,
  disconnectOAuth,
} = require('./common');

const SECTIONS = ['actions', 'features', 'scopes', 'all'];
const SURFACES = ['mcp', 'ai_sdk', 'rest', 'internal'];

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> [...]',
      '',
      'Every subcommand accepts an optional legacy --user <caller-email> hint.',
      'It never selects an identity; the signed invocation owner is authoritative.',
      'When that owner has connected AI Studio with OAuth, that grant is used first.',
      'A legacy stored API key remains supported as a compatibility fallback.',
      '',
      'Connection:',
      '  connect --user <email>       Mint a one-click delegated OAuth link.',
      '  disconnect --user <email>    Revoke the delegated grant.',
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
      '      API-key execution runs only APPROVED assistants (the owner/admin draft',
      '      exception is session-only, i.e. web UI); a draft/pending or missing id',
      '      returns a clean not_executable result (exit 0). Needs',
      '      mcp:execute_assistant (staff + admin).',
      '  search-decisions  [--user <email>] [--query <t>] [--node-type T] [--node-class C]',
      '                    [--limit N] [--cursor C]',
      '  capture-decision  [--user <email>] --decision "<t>" --decided-by "<t>"',
      '                    [--reasoning <t>] [--evidence a,b] [--constraints a,b]',
      '                    [--conditions a,b] [--alternatives a,b] [--related-to uuid,uuid]',
      '                    [--agent-id <t>]   (admin-only: needs mcp:capture_decision)',
      '  get-decision-graph [--user <email>] --node-id <uuid>',
      '',
      'Repositories (delegated OAuth or a key with repository scopes):',
      '  repositories-list [--query <text>] [--limit N]',
      '  repositories-describe --repository-id N',
      '  repositories-search --query <text> [--repository-ids 1,2] [--mode keyword|vector|hybrid]',
      '                      [--modalities text,image,audio,video,table] [--limit N]',
      '  repositories-source --repository-id N --item-id N [--chunk-id N] [--limit N]',
      '  repositories-changes --repository-ids 1,2 [--cursor C] [--limit N]',
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

function parseIntegerList(value, label) {
  const values = parseList(value, label);
  if (values === undefined) return undefined;
  const numbers = values.map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    fail(`--${label} must be a comma-separated list of positive integers`);
  }
  return numbers;
}

function requiredScopeForTool(toolName) {
  const repositoryScopes = {
    repositories_list: 'repositories:list',
    repositories_describe: 'repositories:list',
    repositories_search: 'repositories:search',
    repositories_get_source: 'repositories:read',
    repositories_list_changes: 'repositories:changes',
  };
  return repositoryScopes[toolName] || `mcp:${toolName}`;
}

/** The remediation hint for an insufficient-scope failure — different when the
 *  caller is already on a personal key (re-mint) vs the shared key (store one). */
function scopeHint(keySource, scope) {
  if (keySource === 'oauth') {
    return (
      `Your delegated AI Studio connection lacks ${scope}. Disconnect and run ` +
      '`connect --user <your-email>` to authorize the current scope set.'
    );
  }
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
      ...(insufficient && {
        hint: scopeHint(res.keySource, requiredScopeForTool(toolName)),
      }),
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

  // Legacy compatibility hint only. common.js intentionally ignores it; the
  // signed invocation context is the sole credential-owner authority.
  const email = optStr(args, 'user', 'user');

  switch (subcommand) {
    case 'connect': {
      const ownerEmail = requireStr(args, 'user', 'user');
      const url = await mintConsentUrl(ownerEmail);
      emit({
        status: 'needs-auth',
        kind: 'aistudio',
        consent_url: url,
        consent_chat_hyperlink: `<${url}|Connect AI Studio>`,
        message:
          'Paste consent_chat_hyperlink on its own line, without surrounding markdown.',
      });
      return;
    }

    case 'disconnect': {
      const ownerEmail = requireStr(args, 'user', 'user');
      emit(await disconnectOAuth(ownerEmail));
      return;
    }

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
        // A draft/pending (or missing) assistant is NOT executable on this
        // path — the server masks it as a tool-level error "Record not found in
        // assistant_architects with id: N". The owner/admin draft exception is
        // SESSION-based (getAssistantArchitectByIdAction reads the NextAuth
        // session), and API-key calls carry no session, so it never applies
        // here — even the draft's owner gets not-found over MCP. This is
        // expected, not an upstream failure: report a clean structured result
        // and EXIT 0.
        if (/record not found in assistant_architects/i.test(text)) {
          emit({
            status: 'not_executable',
            assistantId,
            message:
              `Assistant ${assistantId} is not executable via the API — the id ` +
              `does not exist, or it is a draft/pending assistant (API-key ` +
              `execution runs only APPROVED assistants; owners can run their ` +
              `drafts in the Assistant Architect UI instead). Run ` +
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

    case 'repositories-list': {
      const toolArgs = {};
      const query = optStr(args, 'query', 'query');
      const limit = optInt(args, 'limit', 'limit');
      if (query !== undefined) toolArgs.query = query;
      if (limit !== undefined) toolArgs.limit = limit;
      await runToolAndEmit('repositories_list', toolArgs, email);
      return;
    }

    case 'repositories-describe': {
      const repositoryId = optInt(
        args,
        'repository_id',
        'repository-id'
      );
      if (repositoryId === undefined) {
        fail('--repository-id is required');
      }
      await runToolAndEmit(
        'repositories_describe',
        { repositoryId },
        email
      );
      return;
    }

    case 'repositories-search': {
      const query = requireStr(args, 'query', 'query');
      const toolArgs = { query };
      const repositoryIds = parseIntegerList(
        args.repository_ids,
        'repository-ids'
      );
      const mode = optStr(args, 'mode', 'mode');
      const modalities = parseList(args.modalities, 'modalities');
      const limit = optInt(args, 'limit', 'limit');
      if (repositoryIds !== undefined) toolArgs.repositoryIds = repositoryIds;
      if (mode !== undefined) {
        if (!['keyword', 'vector', 'hybrid'].includes(mode)) {
          fail('--mode must be keyword, vector, or hybrid');
        }
        toolArgs.mode = mode;
      }
      if (modalities !== undefined) toolArgs.modalities = modalities;
      if (limit !== undefined) toolArgs.limit = limit;
      await runToolAndEmit('repositories_search', toolArgs, email);
      return;
    }

    case 'repositories-source': {
      const repositoryId = optInt(
        args,
        'repository_id',
        'repository-id'
      );
      const itemId = optInt(args, 'item_id', 'item-id');
      if (repositoryId === undefined || itemId === undefined) {
        fail('--repository-id and --item-id are required');
      }
      const toolArgs = { repositoryId, itemId };
      const chunkId = optInt(args, 'chunk_id', 'chunk-id');
      const limit = optInt(args, 'limit', 'limit');
      if (chunkId !== undefined) toolArgs.chunkId = chunkId;
      if (limit !== undefined) toolArgs.limit = limit;
      await runToolAndEmit('repositories_get_source', toolArgs, email);
      return;
    }

    case 'repositories-changes': {
      const repositoryIds = parseIntegerList(
        args.repository_ids,
        'repository-ids'
      );
      if (!repositoryIds) fail('--repository-ids is required');
      const toolArgs = { repositoryIds };
      const cursor = optStr(args, 'cursor', 'cursor');
      const limit = optInt(args, 'limit', 'limit');
      if (cursor !== undefined) toolArgs.cursor = cursor;
      if (limit !== undefined) toolArgs.limit = limit;
      await runToolAndEmit('repositories_list_changes', toolArgs, email);
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
