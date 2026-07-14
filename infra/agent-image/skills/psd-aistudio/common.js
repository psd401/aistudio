/**
 * Shared helpers for the psd-aistudio OpenClaw skill (Issues #1100, #1223).
 *
 * Thin JSON-RPC client for AI Studio's existing `/api/mcp` endpoint.
 *
 * Key resolution (#1223) is per-caller with a shared fallback:
 *   1. OVERRIDE — the caller's OWN AI Studio API key, if they have stored one
 *      (`psd-credentials get --user <email> --name aistudio_personal_key`). When
 *      present it replaces the shared key for that caller, unlocking exactly
 *      whatever that key's scopes grant (execute assistants, capture decisions, …).
 *      Scope is enforced SERVER-SIDE by the key; this skill is a thin passthrough.
 *   2. FALLBACK — the pre-provisioned, shared `platform:read` key (discovery only).
 *      A caller with no personal key still works, limited to discovery.
 * The skill emits WHICH key was used (`personal` vs `shared`) to stderr — never
 * the value — so the agent can steer the user to store their own key.
 *
 * Environment contract (set by infra/lib/agent-platform-stack.ts + deploy):
 *   AISTUDIO_MCP_URL                 — AI Studio MCP JSON-RPC endpoint (/api/mcp)
 *   AISTUDIO_MCP_API_KEY             — shared scoped `sk-…` key (platform:read).
 *                                      Direct. The FALLBACK key — not a new secret.
 *   AISTUDIO_MCP_API_KEY_SECRET_ID   — Secrets Manager id holding the shared `sk-…`
 *                                      key (used when the direct env var is absent).
 *
 * The per-user override reuses the EXISTING psd-credentials contract
 * (user-scoped secret at psd-agent-creds/{env}/user/<email>/aistudio_personal_key);
 * this skill introduces no new secret and no new resolver.
 */

'use strict';

const path = require('node:path');
const childProcess = require('node:child_process');

// Absolute path to the shared psd-credentials `get.js` (…/skills/psd-credentials).
const CREDENTIALS_GET = path.resolve(
  __dirname,
  '..',
  'psd-credentials',
  'get.js'
);

// Indirection seam so unit tests can stub the psd-credentials subprocess without
// mocking a `node:` builtin (bun's mock.module does not intercept builtin requires).
const _internals = { execFileSync: childProcess.execFileSync };

const AISTUDIO_MCP_URL = process.env.AISTUDIO_MCP_URL || '';
const AISTUDIO_MCP_API_KEY = process.env.AISTUDIO_MCP_API_KEY || '';
const AISTUDIO_MCP_API_KEY_SECRET_ID =
  process.env.AISTUDIO_MCP_API_KEY_SECRET_ID || '';

// Per-user credential name in psd-credentials (stored via
// `psd-credentials put --user <email> --name aistudio_personal_key --value sk-…`).
const PERSONAL_KEY_NAME = 'aistudio_personal_key';

// Upper bound on a single /api/mcp call. execute_assistant runs a full LLM
// completion server-side, so this is generous — but without an explicit signal a
// hung upstream (ALB/proxy that never closes the response) would stall the agent
// for undici's ~300s platform default with zero output.
const MCP_FETCH_TIMEOUT_MS = 180_000;

// Stderr notice emitted when the caller falls back to the shared discovery key.
// Never contains a key value.
const SHARED_KEY_NOTICE =
  'psd-aistudio: using the shared platform:read key (discovery only). Store your ' +
  'own AI Studio API key (psd-credentials put --name aistudio_personal_key) to act ' +
  'as yourself and unlock execute/capture.\n';

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
 * Load the AWS SDK the same way psd-data does — prefer psd-workspace's
 * already-installed copy so this skill adds no image dependency, falling back to
 * a bare require for local/testing. Only reached when the secret path is used.
 */
function requireSecretsManager() {
  try {
    return require('/opt/psd-skills/psd-workspace/node_modules/@aws-sdk/client-secrets-manager');
  } catch {
    return require('@aws-sdk/client-secrets-manager');
  }
}

/**
 * Read the caller's per-user AI Studio key from psd-credentials, if stored.
 * Shells out to the SAME `psd-credentials/get.js` contract every other skill
 * uses (user-scoped first, then shared) — no new resolver. Returns the raw
 * `sk-…` string on success, or `null` when no personal key is stored / the
 * per-user store is unreachable (in which case we degrade to the shared key).
 * The value is returned to the caller and used only as a Bearer token — never
 * logged, never written to disk. The subprocess call goes through the
 * `_internals` seam so tests can stub it.
 */
function readPersonalKey(callerEmail) {
  let stdout;
  try {
    stdout = _internals.execFileSync(
      'node',
      [CREDENTIALS_GET, '--user', callerEmail, '--name', PERSONAL_KEY_NAME],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 10_000 }
    );
  } catch (err) {
    // get.js exited non-zero (bad env / Secrets Manager error / crash) or timed
    // out. Not fatal: the caller can still use the shared discovery key. Report
    // only the exit status/code — execFileSync's err.message echoes the full
    // argv (including the caller's email), which doesn't belong on stderr.
    process.stderr.write(
      `psd-aistudio: could not read your personal key ` +
        `(psd-credentials get failed: ${err.status ?? err.code ?? 'unknown'}); ` +
        'falling back to the shared key.\n'
    );
    return null;
  }

  const lines = String(stdout)
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
  // get.js emits `{error:"not_found", …}` (exit 0) when nothing is stored, and
  // `scope: 'user' | 'shared'` on a hit. Only a USER-scoped hit is a personal
  // key: get.js falls back to the shared namespace for the same name, and a
  // same-named shared secret (admin-provisioned out of band) must not be
  // relabeled `personal` — that would mislabel stderr and give the wrong
  // remediation hint. Treat it like not-found and use the platform:read
  // fallback. The value must be a string: it becomes a Bearer header.
  if (parsed.error || typeof parsed.value !== 'string' || !parsed.value) {
    return null;
  }
  if (parsed.scope !== 'user') return null;
  return parsed.value;
}

/**
 * Resolve the API key to authenticate with, honoring the #1223 override model.
 * Returns `{ key, source }` where `source` is `'personal'` (the caller's own
 * stored key) or `'shared'` (the pre-provisioned platform:read fallback). Emits
 * the source to stderr (never the value). Does NOT cache: each invocation makes
 * exactly one MCP call, so one resolution per process.
 */
async function resolveApiKey(callerEmail) {
  // 1. OVERRIDE — the caller's own stored key wins when present.
  if (callerEmail) {
    const personal = readPersonalKey(callerEmail);
    if (personal) {
      process.stderr.write(
        'psd-aistudio: using your personal AI Studio API key (overrides the ' +
          'shared key; you can do whatever that key is scoped for).\n'
      );
      return { key: personal, source: 'personal' };
    }
  }

  // 2. FALLBACK — the existing shared platform:read key (direct env wins).
  if (AISTUDIO_MCP_API_KEY) {
    process.stderr.write(SHARED_KEY_NOTICE);
    return { key: AISTUDIO_MCP_API_KEY, source: 'shared' };
  }
  if (AISTUDIO_MCP_API_KEY_SECRET_ID) {
    let value;
    try {
      const { SecretsManagerClient, GetSecretValueCommand } =
        requireSecretsManager();
      const client = new SecretsManagerClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });
      const resp = await client.send(
        new GetSecretValueCommand({ SecretId: AISTUDIO_MCP_API_KEY_SECRET_ID })
      );
      value = (resp.SecretString || '').trim();
    } catch (err) {
      // A retrieval failure (permission / decryption / network) is an infra
      // error, not a malformed invocation — surface it clearly (exit 12) instead
      // of letting it bubble to the generic exit-2 handler.
      fail(
        `Failed to retrieve API key from Secrets Manager ` +
          `(${AISTUDIO_MCP_API_KEY_SECRET_ID}): ${err.message}`,
        12
      );
    }
    // Secret exists but is empty — the credential is effectively missing.
    if (!value) {
      fail(
        `Secret ${AISTUDIO_MCP_API_KEY_SECRET_ID} has no SecretString value`,
        11
      );
    }
    process.stderr.write(SHARED_KEY_NOTICE);
    return { key: value, source: 'shared' };
  }

  // 3. No credential configured at all — access to AI Studio is not set up.
  fail(
    'No API key configured. Set AISTUDIO_MCP_API_KEY (a scoped sk- key holding ' +
      'platform:read) or AISTUDIO_MCP_API_KEY_SECRET_ID, or store your own key ' +
      'with psd-credentials put --name aistudio_personal_key.',
    11
  );
  return { key: '', source: 'shared' }; // unreachable
}

/**
 * Low-level MCP call. Resolves the key (honoring the per-user override), sends
 * the JSON-RPC envelope, and handles the terminal transport failures uniformly
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
async function callMcpRaw(method, params, callerEmail) {
  if (!AISTUDIO_MCP_URL) {
    fail('AISTUDIO_MCP_URL is not set');
  }

  const { key: apiKey, source: keySource } = await resolveApiKey(callerEmail);

  const requestId = Math.floor(Math.random() * 1e9);
  const rpcBody = {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params: params || {},
  };

  let resp;
  try {
    resp = await fetch(AISTUDIO_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(MCP_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    fail(
      timedOut
        ? `AI Studio MCP did not respond within ${MCP_FETCH_TIMEOUT_MS / 1000}s`
        : `Network error calling AI Studio MCP: ${err.message}`,
      12
    );
  }

  if (resp.status === 401) {
    const text = await resp.text().catch(() => '');
    emit({
      status: 'unauthorized',
      message:
        'AI Studio MCP rejected the API key (401). ' +
        (keySource === 'personal'
          ? 'Your stored AI Studio key is invalid or revoked — re-store a current ' +
            'key with psd-credentials put --name aistudio_personal_key.'
          : 'The shared key must be a valid sk- key holding at least platform:read.'),
      detail: text.slice(0, 512),
    });
    process.exit(11);
  }
  if (resp.status === 429) {
    emit({
      status: 'rate-limited',
      message:
        'AI Studio MCP is rate-limiting requests for this key. Wait and retry.',
    });
    process.exit(14);
  }

  const data = await resp.json().catch(() => null);
  if (!data) {
    const text = resp.ok ? '' : ` (HTTP ${resp.status})`;
    fail(`AI Studio MCP returned a non-JSON body${text}`, 12);
  }

  if (data.error) {
    // JSON-RPC error (e.g. "Insufficient scope for tool: execute_assistant",
    // unknown tool). Return it verbatim; the caller surfaces it (+ scope hint)
    // and exits — do NOT retry, do NOT fall back to another key.
    return { jsonrpcError: data.error, httpStatus: resp.status, keySource };
  }

  // A non-2xx status with a JSON body but NO JSON-RPC error field (e.g. an infra
  // 502/503 proxy page) must NOT be treated as success — otherwise we'd silently
  // return `null`, hiding the real HTTP status (CLAUDE.md silent-failure pattern).
  if (!resp.ok) {
    fail(
      `AI Studio MCP returned HTTP ${resp.status}: ` +
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
    callerEmail
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
  resolveApiKey,
  callMcpRaw,
  callMcp,
  callTool,
  unwrapResult,
  AISTUDIO_MCP_URL,
  PERSONAL_KEY_NAME,
  _internals,
};
