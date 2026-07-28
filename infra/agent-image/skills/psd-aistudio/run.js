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
 *     list-assistants / execute-assistant / create-assistant /
 *     update-assistant / fork-assistant
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
 *   node run.js create-assistant [--user <email>] (--file <export.json> | --json '<ExportFormat>')
 *   node run.js update-assistant [--user <email>] --id <n> (--file <export.json> | --json '<ExportFormat>')
 *   node run.js fork-assistant [--user <email>] --id <n> [--name <text>]
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

"use strict";

const fs = require("node:fs");
const {
  fail,
  emit,
  parseArgs,
  callMcp,
  callTool,
  mintConsentUrl,
  disconnectOAuth,
} = require("./common");

const SECTIONS = ["actions", "features", "scopes", "all"];
const SURFACES = ["mcp", "ai_sdk", "rest", "internal"];
const ASSISTANT_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

function usage() {
  process.stdout.write(
    [
      "Usage: node run.js <subcommand> [...]",
      "",
      "Every subcommand accepts an optional legacy --user <caller-email> hint.",
      "It never selects an identity; the signed invocation owner is authoritative.",
      "When that owner has connected AI Studio with OAuth, that grant is used first.",
      "A legacy stored API key remains supported as a compatibility fallback.",
      "",
      "Connection:",
      "  connect --user <email>       Mint a one-click delegated OAuth link.",
      "  disconnect --user <email>    Revoke the delegated grant.",
      "",
      "Discovery (shared platform:read key is enough):",
      "  capabilities [--section actions|features|scopes|all]",
      "               [--surface mcp|ai_sdk|rest|internal] [--query <text>] [--user <email>]",
      "      Live catalog of what AI Studio can do.",
      "  list [--user <email>]",
      "      Raw MCP tools/list — every tool name, description, and inputSchema the",
      "      resolved key can see.",
      "",
      "Actions (need the caller's own scoped key — store it with",
      "psd-credentials put --name aistudio_personal_key):",
      "  list-assistants   [--user <email>] [--search <t>] [--status <s>] [--limit N] [--cursor C]",
      '  execute-assistant [--user <email>] --id <n> [--inputs \'{"field":"value"}\']',
      "      API-key execution runs only APPROVED assistants (the owner/admin draft",
      "      exception is session-only, i.e. web UI); a draft/pending or missing id",
      "      returns a clean not_executable result (exit 0). Needs",
      "      mcp:execute_assistant (staff + admin).",
      "  create-assistant [--user <email>] (--file <export.json> | --json '<ExportFormat>')",
      "  update-assistant [--user <email>] --id <n> (--file <export.json> | --json '<ExportFormat>')",
      "  fork-assistant   [--user <email>] --id <n> [--name <text>]",
      "      Create/update/fork always lands in pending_approval. Update is",
      "      owner-or-admin; fork uses the caller's current assistant visibility.",
      "  search-decisions  [--user <email>] [--query <t>] [--node-type T] [--node-class C]",
      "                    [--limit N] [--cursor C]",
      '  capture-decision  [--user <email>] --decision "<t>" --decided-by "<t>"',
      "                    [--reasoning <t>] [--evidence a,b] [--constraints a,b]",
      "                    [--conditions a,b] [--alternatives a,b] [--related-to uuid,uuid]",
      "                    [--agent-id <t>]   (admin-only: needs mcp:capture_decision)",
      "  get-decision-graph [--user <email>] --node-id <uuid>",
      "",
      "Repositories (delegated OAuth or a key with repository scopes):",
      "  repositories-list [--query <text>] [--limit N]",
      "  repositories-describe --repository-id N",
      "  repositories-search --query <text> [--repository-ids 1,2] [--mode keyword|vector|hybrid]",
      "                      [--modalities text,image,audio,video,table] [--limit N]",
      "  repositories-source --repository-id N --item-id N [--chunk-id N] [--limit N]",
      "  repositories-changes --repository-ids 1,2 [--cursor C] [--limit N]",
      "",
    ].join("\n"),
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
  if (v === undefined || v === true || v === "") fail(`--${label} is required`);
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
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
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

function readBoundedImportFile(file) {
  // Open once, inspect that exact descriptor, and read no more than its
  // inspected size. A concurrently growing file is therefore still bounded.
  // The CLI rejects devices/FIFOs so a pseudo-file cannot block indefinitely.
  // The caller-selected path is an intentional part of the CLI contract.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const descriptor = fs.openSync(file, "r");
  try {
    const fileStats = fs.fstatSync(descriptor);
    if (!fileStats.isFile()) {
      throw new Error("--file must refer to a regular file");
    }
    if (fileStats.size > ASSISTANT_IMPORT_MAX_BYTES) {
      throw new Error("assistant import file exceeds the 10 MB limit");
    }

    const buffer = Buffer.alloc(fileStats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseImportEnvelope(args) {
  const json = optStr(args, "json", "json");
  const file = optStr(args, "file", "file");
  if ((json === undefined) === (file === undefined)) {
    fail(
      "Provide exactly one of --file <export.json> or --json '<ExportFormat>'",
    );
  }

  let raw;
  if (file !== undefined) {
    try {
      raw = readBoundedImportFile(file);
    } catch (error) {
      fail(`Unable to read --file: ${error.message}`);
    }
  } else {
    raw = json;
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    fail(`Assistant import envelope must be valid JSON: ${error.message}`);
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope)
  ) {
    fail("Assistant import envelope must be a JSON object");
  }
  return envelope;
}

function requiredScopeForTool(toolName) {
  const repositoryScopes = {
    repositories_list: "repositories:list",
    repositories_describe: "repositories:list",
    repositories_search: "repositories:search",
    repositories_get_source: "repositories:read",
    repositories_list_changes: "repositories:changes",
  };
  return repositoryScopes[toolName] || `mcp:${toolName}`;
}

/** The remediation hint for an insufficient-scope failure — different when the
 *  caller is already on a personal key (re-mint) vs the shared key (store one). */
function scopeHint(keySource, scope) {
  if (keySource === "oauth") {
    return (
      `Your delegated AI Studio connection lacks ${scope}. Disconnect and run ` +
      "`connect --user <your-email>` to authorize the current scope set."
    );
  }
  if (keySource === "personal") {
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
    const msg = (res.jsonrpcError && res.jsonrpcError.message) || "";
    const insufficient = /insufficient scope/i.test(msg);
    // Every MCP tool's required scope is `mcp:<toolName>` (see
    // lib/tools/catalog/manifest.ts) — the server is the real enforcement point;
    // this only makes the hint specific.
    emit({
      status: "mcp-error",
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
    typeof res.payload === "string" ? res.payload : JSON.stringify(res.payload);
  emit({ status: "tool-error", tool: toolName, message: text });
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

async function connectCommand(args) {
  const ownerEmail = requireStr(args, "user", "user");
  const url = await mintConsentUrl(ownerEmail);
  emit({
    status: "needs-auth",
    kind: "aistudio",
    consent_url: url,
    consent_chat_hyperlink: `<${url}|Connect AI Studio>`,
    message:
      "Paste consent_chat_hyperlink on its own line, without surrounding markdown.",
  });
}

async function disconnectCommand(args) {
  emit(await disconnectOAuth(requireStr(args, "user", "user")));
}

async function capabilitiesCommand(args, email) {
  const toolArgs = {};
  const section = optStr(args, "section", "section");
  const surface = optStr(args, "surface", "surface");
  const query = optStr(args, "query", "query");
  if (section !== undefined && !SECTIONS.includes(section)) {
    fail(`--section must be one of: ${SECTIONS.join(", ")}`);
  }
  if (surface !== undefined && !SURFACES.includes(surface)) {
    fail(`--surface must be one of: ${SURFACES.join(", ")}`);
  }
  if (section !== undefined) toolArgs.section = section;
  if (surface !== undefined) toolArgs.surface = surface;
  if (query !== undefined) toolArgs.query = query;
  await callMcp(
    "tools/call",
    { name: "describe_capabilities", arguments: toolArgs },
    email,
  );
}

async function listCommand(_args, email) {
  await callMcp("tools/list", {}, email);
}

async function listAssistantsCommand(args, email) {
  const toolArgs = {};
  const optionalArgs = {
    search: optStr(args, "search", "search"),
    status: optStr(args, "status", "status"),
    limit: optInt(args, "limit", "limit"),
    cursor: optStr(args, "cursor", "cursor"),
  };
  for (const [key, value] of Object.entries(optionalArgs)) {
    if (value !== undefined) toolArgs[key] = value;
  }
  await runToolAndEmit("list_assistants", toolArgs, email);
}

function parseAssistantInputs(args) {
  if (args.inputs === undefined) return {};
  if (args.inputs === true) fail("--inputs requires a JSON object value");

  let inputs;
  try {
    inputs = JSON.parse(args.inputs);
  } catch (error) {
    fail(`--inputs must be valid JSON: ${error.message}`);
  }
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    fail('--inputs must be a JSON object, e.g. \'{"field":"value"}\'');
  }
  return inputs;
}

function assistantNotExecutable(res, assistantId) {
  if (!res.isError) return false;
  const text =
    typeof res.payload === "string" ? res.payload : JSON.stringify(res.payload);
  if (!/record not found in assistant_architects/i.test(text)) return false;

  emit({
    status: "not_executable",
    assistantId,
    message:
      `Assistant ${assistantId} is not executable via the API — the id ` +
      `does not exist, or it is a draft/pending assistant (API-key ` +
      `execution runs only APPROVED assistants; owners can run their ` +
      `drafts in the Assistant Architect UI instead). Run ` +
      `\`list-assistants --status approved\` to find an executable one.`,
  });
  return true;
}

async function executeAssistantCommand(args, email) {
  const assistantId = optInt(args, "id", "id");
  if (assistantId === undefined) fail("--id <assistant-id> is required");

  const res = await callTool(
    "execute_assistant",
    { assistantId, inputs: parseAssistantInputs(args) },
    email,
  );
  if (res.jsonrpcError) surfaceToolError(res, "execute_assistant");
  if (assistantNotExecutable(res, assistantId)) return;
  if (res.isError) surfaceToolError(res, "execute_assistant");
  emit(res.payload);
}

async function createAssistantCommand(args, email) {
  await runToolAndEmit("create_assistant", parseImportEnvelope(args), email);
}

async function updateAssistantCommand(args, email) {
  const assistantId = optInt(args, "id", "id");
  if (assistantId === undefined) fail("--id <assistant-id> is required");
  await runToolAndEmit(
    "update_assistant",
    { ...parseImportEnvelope(args), assistantId },
    email,
  );
}

async function forkAssistantCommand(args, email) {
  const assistantId = optInt(args, "id", "id");
  if (assistantId === undefined) fail("--id <assistant-id> is required");
  const name = optStr(args, "name", "name");
  await runToolAndEmit(
    "fork_assistant",
    { assistantId, ...(name !== undefined ? { name } : {}) },
    email,
  );
}

async function searchDecisionsCommand(args, email) {
  const toolArgs = {};
  const optionalArgs = {
    query: optStr(args, "query", "query"),
    nodeType: optStr(args, "node_type", "node-type"),
    nodeClass: optStr(args, "node_class", "node-class"),
    limit: optInt(args, "limit", "limit"),
    cursor: optStr(args, "cursor", "cursor"),
  };
  for (const [key, value] of Object.entries(optionalArgs)) {
    if (value !== undefined) toolArgs[key] = value;
  }
  await runToolAndEmit("search_decisions", toolArgs, email);
}

async function captureDecisionCommand(args, email) {
  const toolArgs = {
    decision: requireStr(args, "decision", "decision"),
    decidedBy: requireStr(args, "decided_by", "decided-by"),
  };
  const optionalArgs = {
    reasoning: optStr(args, "reasoning", "reasoning"),
    evidence: parseList(args.evidence, "evidence"),
    constraints: parseList(args.constraints, "constraints"),
    conditions: parseList(args.conditions, "conditions"),
    alternatives_considered: parseList(args.alternatives, "alternatives"),
    relatedTo: parseList(args.related_to, "related-to"),
    agentId: optStr(args, "agent_id", "agent-id"),
  };
  for (const [key, value] of Object.entries(optionalArgs)) {
    if (value !== undefined) toolArgs[key] = value;
  }
  await runToolAndEmit("capture_decision", toolArgs, email);
}

async function getDecisionGraphCommand(args, email) {
  const nodeId = requireStr(args, "node_id", "node-id");
  await runToolAndEmit("get_decision_graph", { nodeId }, email);
}

async function repositoriesListCommand(args, email) {
  const toolArgs = {};
  const query = optStr(args, "query", "query");
  const limit = optInt(args, "limit", "limit");
  if (query !== undefined) toolArgs.query = query;
  if (limit !== undefined) toolArgs.limit = limit;
  await runToolAndEmit("repositories_list", toolArgs, email);
}

async function repositoriesDescribeCommand(args, email) {
  const repositoryId = optInt(args, "repository_id", "repository-id");
  if (repositoryId === undefined) fail("--repository-id is required");
  await runToolAndEmit("repositories_describe", { repositoryId }, email);
}

async function repositoriesSearchCommand(args, email) {
  const toolArgs = { query: requireStr(args, "query", "query") };
  const repositoryIds = parseIntegerList(args.repository_ids, "repository-ids");
  const mode = optStr(args, "mode", "mode");
  const modalities = parseList(args.modalities, "modalities");
  const limit = optInt(args, "limit", "limit");
  if (repositoryIds !== undefined) toolArgs.repositoryIds = repositoryIds;
  if (mode !== undefined && !["keyword", "vector", "hybrid"].includes(mode)) {
    fail("--mode must be keyword, vector, or hybrid");
  }
  if (mode !== undefined) toolArgs.mode = mode;
  if (modalities !== undefined) toolArgs.modalities = modalities;
  if (limit !== undefined) toolArgs.limit = limit;
  await runToolAndEmit("repositories_search", toolArgs, email);
}

async function repositoriesSourceCommand(args, email) {
  const repositoryId = optInt(args, "repository_id", "repository-id");
  const itemId = optInt(args, "item_id", "item-id");
  if (repositoryId === undefined || itemId === undefined) {
    fail("--repository-id and --item-id are required");
  }
  const toolArgs = { repositoryId, itemId };
  const chunkId = optInt(args, "chunk_id", "chunk-id");
  const limit = optInt(args, "limit", "limit");
  if (chunkId !== undefined) toolArgs.chunkId = chunkId;
  if (limit !== undefined) toolArgs.limit = limit;
  await runToolAndEmit("repositories_get_source", toolArgs, email);
}

async function repositoriesChangesCommand(args, email) {
  const repositoryIds = parseIntegerList(args.repository_ids, "repository-ids");
  if (!repositoryIds) fail("--repository-ids is required");
  const toolArgs = { repositoryIds };
  const cursor = optStr(args, "cursor", "cursor");
  const limit = optInt(args, "limit", "limit");
  if (cursor !== undefined) toolArgs.cursor = cursor;
  if (limit !== undefined) toolArgs.limit = limit;
  await runToolAndEmit("repositories_list_changes", toolArgs, email);
}

const COMMAND_HANDLERS = {
  connect: connectCommand,
  disconnect: disconnectCommand,
  capabilities: capabilitiesCommand,
  list: listCommand,
  "list-assistants": listAssistantsCommand,
  "execute-assistant": executeAssistantCommand,
  "create-assistant": createAssistantCommand,
  "update-assistant": updateAssistantCommand,
  "fork-assistant": forkAssistantCommand,
  "search-decisions": searchDecisionsCommand,
  "capture-decision": captureDecisionCommand,
  "get-decision-graph": getDecisionGraphCommand,
  "repositories-list": repositoriesListCommand,
  "repositories-describe": repositoriesDescribeCommand,
  "repositories-search": repositoriesSearchCommand,
  "repositories-source": repositoriesSourceCommand,
  "repositories-changes": repositoriesChangesCommand,
};

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
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
  const email = optStr(args, "user", "user");
  const handler = COMMAND_HANDLERS[subcommand];
  if (!handler) {
    fail(`Unknown subcommand: ${subcommand}. Run with --help to see options.`);
  }
  await handler(args, email);
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err), 2);
  });
}

module.exports = { main };
