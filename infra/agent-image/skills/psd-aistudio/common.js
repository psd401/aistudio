/** Owner-bound AI Studio MCP client. Provider keys stay in the trusted web tier. */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');
const _internals = { requestAgentBroker };

// Upper bound on a single /api/mcp call. Without an explicit signal a hung
// upstream (ALB/proxy that never closes the response) would stall the agent for
// undici's ~300s platform default with zero output.
const MCP_FETCH_TIMEOUT_MS = 180_000;

// execute_assistant runs a full server-side assistant execution inside the MCP
// request: /api/mcp and the v1 execute route both declare `maxDuration = 900`,
// and a single reasoning prompt can legitimately take 300s before multi-prompt
// chains. Wait slightly PAST the server ceiling so the server's own timeout
// error surfaces (attributable) instead of a local abort (ambiguous).
const MCP_EXECUTE_TIMEOUT_MS = 910_000;

/** Per-tool call timeout — execute_assistant is the only long-running tool. */
function timeoutForTool(toolName) {
  return toolName === 'execute_assistant'
    ? MCP_EXECUTE_TIMEOUT_MS
    : MCP_FETCH_TIMEOUT_MS;
}

function fail(message, code = 1) {
  process.stderr.write(`psd-aistudio: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Minimal long-form argv parser. `--foo bar` and `--foo` (boolean) supported;
 * dashes in key names become underscores. Mirrors psd-data/psd-workspace.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Mint the one-click OAuth link through the signed invocation broker. The
 * legacy callerEmail argument is intentionally ignored: the server derives the
 * immutable owner from the router-signed context.
 */
async function mintConsentUrl(callerEmail) {
  void callerEmail;
  const result = await _internals.requestAgentBroker(
    '/api/agent/consent-link',
    { kind: 'aistudio' }
  );
  if (!result || typeof result.url !== 'string') {
    throw new Error('Connection-link broker returned an invalid success payload');
  }
  return result.url;
}

/**
 * Revoke the current invocation owner's delegated grant. No model-selected
 * owner crosses the broker boundary.
 */
async function disconnectOAuth(callerEmail) {
  void callerEmail;
  return _internals.requestAgentBroker('/api/agent/aistudio', {
    operation: 'disconnect',
  });
}

/**
 * Low-level MCP call through the owner-bound broker. The model runtime never
 * receives either the owner's personal key or the platform fallback key.
 * Handles terminal transport failures uniformly
 * (401 → exit 11, 429 → exit 14, network / non-JSON / non-2xx-without-error →
 * exit 12). It does NOT emit/exit for a JSON-RPC error or a success — it RETURNS
 * those so the caller can add a scope hint or post-process a tool result:
 *
 *   success       → { result, keySource }
 *   JSON-RPC error → { jsonrpcError, httpStatus, keySource }
 *
 * /api/mcp returns HTTP 200 with a JSON-RPC envelope for tool results AND
 * tool-level errors (insufficient scope, unknown tool). Only auth/rate-limit/
 * parse failures use HTTP status codes; both are handled.
 */
async function callMcpRaw(method, params, callerEmail, timeoutMs = MCP_FETCH_TIMEOUT_MS) {
  void callerEmail;
  let brokerResult;
  try {
    brokerResult = await _internals.requestAgentBroker(
      '/api/agent/aistudio',
      { method, params: params || {} },
      { timeoutMs }
    );
  } catch (err) {
    const timedOut =
      err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    fail(
      timedOut
        ? `AI Studio MCP did not respond within ${timeoutMs / 1000}s`
        : `Network error calling AI Studio MCP: ${err.message}`,
      12
    );
  }

  const httpStatus = Number(brokerResult.httpStatus);
  const keySource =
    brokerResult.keySource === 'oauth'
      ? 'oauth'
      : brokerResult.keySource === 'personal'
        ? 'personal'
        : 'shared';
  const data = brokerResult.payload;
  if (httpStatus === 401) {
    emit({
      status: 'unauthorized',
      message:
        'AI Studio MCP rejected the API key (401). ' +
        (keySource === 'oauth'
          ? 'Your delegated connection expired or was revoked — run connect again.'
          : keySource === 'personal'
          ? 'Your stored AI Studio key is invalid or revoked — re-store a current ' +
            'key with psd-credentials put --name aistudio_personal_key.'
          : 'The shared key must be a valid sk- key holding at least platform:read.'),
      detail: String(brokerResult.rawText || '').slice(0, 512),
    });
    process.exit(11);
  }
  if (httpStatus === 429) {
    emit({
      status: 'rate-limited',
      message:
        'AI Studio MCP is rate-limiting requests for this key. Wait and retry.',
    });
    process.exit(14);
  }

  if (!data) {
    fail(`AI Studio MCP returned a non-JSON body (HTTP ${httpStatus})`, 12);
  }

  if (data.error) {
    // JSON-RPC error (e.g. "Insufficient scope for tool: execute_assistant",
    // unknown tool). Return it verbatim; the caller surfaces it (+ scope hint)
    // and exits — do NOT retry, do NOT fall back to another key.
    return { jsonrpcError: data.error, httpStatus, keySource };
  }

  // A non-2xx status with a JSON body but NO JSON-RPC error field (e.g. an infra
  // 502/503 proxy page) must NOT be treated as success — otherwise we'd silently
  // return `null`, hiding the real HTTP status (CLAUDE.md silent-failure pattern).
  if (httpStatus < 200 || httpStatus >= 300) {
    fail(
      `AI Studio MCP returned HTTP ${httpStatus}: ` +
        `${JSON.stringify(data).slice(0, 512)}`,
      12
    );
  }

  // HTTP 200 with NEITHER `result` NOR `error` is a malformed JSON-RPC envelope
  // (proxy/gateway body corruption) — emitting `null` as a success would hide
  // it. A present-but-null `result` is still a legitimate success.
  if (typeof data !== 'object' || !('result' in data)) {
    fail(
      `AI Studio MCP returned HTTP 200 without a JSON-RPC result or error: ` +
        `${JSON.stringify(data).slice(0, 512)}`,
      12
    );
  }

  return { result: data.result ?? null, keySource };
}

/**
 * Back-compat entry point used by the discovery subcommands (`capabilities`,
 * `list`). Reproduces the original behavior exactly: writes the JSON-RPC result
 * to stdout on success; emits a structured `mcp-error` and exits 12 on a
 * JSON-RPC error. Returns the result on success.
 */
async function callMcp(method, params, callerEmail) {
  const out = await callMcpRaw(method, params, callerEmail);
  if (out.jsonrpcError) {
    emit({
      status: 'mcp-error',
      method,
      http_status: out.httpStatus,
      jsonrpc_error: out.jsonrpcError,
    });
    process.exit(12);
  }
  process.stdout.write(JSON.stringify(out.result) + '\n');
  return out.result;
}

/**
 * Unwrap an MCP tool result envelope (`{ content: [{ type:'text', text }], isError? }`).
 * MCP tool handlers return their payload as a JSON string in the first text
 * content part; parse it back to an object for the agent. Returns
 * `{ isError, data }` where `data` is the parsed payload (or the raw text /
 * whole result when it is not JSON).
 */
function unwrapResult(result) {
  const isError = !!(result && result.isError);
  const first =
    result && Array.isArray(result.content) ? result.content[0] : null;
  const text = first && typeof first.text === 'string' ? first.text : null;
  let data;
  if (text !== null) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  } else {
    data = result ?? null;
  }
  return { isError, data };
}

/**
 * High-level `tools/call` helper for the action subcommands. Does NOT emit or
 * exit (except the shared transport failures inside callMcpRaw) so run.js owns
 * the presentation — the not_executable mapping, the insufficient-scope hint,
 * and the exit code. Returns one of:
 *
 *   JSON-RPC error → { jsonrpcError, httpStatus, keySource }
 *   tool result    → { isError, payload, keySource }
 */
async function callTool(toolName, toolArgs, callerEmail) {
  const out = await callMcpRaw(
    'tools/call',
    { name: toolName, arguments: toolArgs || {} },
    callerEmail,
    timeoutForTool(toolName)
  );
  if (out.jsonrpcError) {
    return {
      jsonrpcError: out.jsonrpcError,
      httpStatus: out.httpStatus,
      keySource: out.keySource,
    };
  }
  const { isError, data } = unwrapResult(out.result);
  return { isError, payload: data, keySource: out.keySource };
}

module.exports = {
  fail,
  emit,
  parseArgs,
  mintConsentUrl,
  disconnectOAuth,
  callMcpRaw,
  callMcp,
  callTool,
  unwrapResult,
  timeoutForTool,
  MCP_FETCH_TIMEOUT_MS,
  MCP_EXECUTE_TIMEOUT_MS,
  _internals,
};
