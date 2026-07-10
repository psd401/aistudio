/**
 * Shared helpers for the psd-aistudio OpenClaw skill (Issue #1100).
 *
 * Thin JSON-RPC client for AI Studio's existing `/api/mcp` endpoint. Unlike
 * psd-data (which mints a per-user Cognito id_token), this skill authenticates
 * with a single scoped API key (`sk-…`) holding the low-sensitivity
 * `platform:read` scope — the capability catalog is non-sensitive product
 * metadata, not user data, so there is no per-user identity to assume for v1.
 *
 * Environment contract (set by infra/lib/agent-platform-stack.ts + deploy):
 *   AISTUDIO_MCP_URL                 — AI Studio MCP JSON-RPC endpoint (/api/mcp)
 *   AISTUDIO_MCP_API_KEY             — scoped `sk-…` key (platform:read). Direct.
 *   AISTUDIO_MCP_API_KEY_SECRET_ID   — Secrets Manager id holding the `sk-…` key
 *                                      (used when the direct env var is absent).
 *
 * The PRODUCTION agent-image credential (a dedicated agent service-account key,
 * or per-user JWT) is shared with / dependent on the in-progress MCP action-tool
 * work — this skill deliberately does NOT invent a second mechanism. Until that
 * lands, set AISTUDIO_MCP_API_KEY (or the secret) to a dev `platform:read` key.
 */

'use strict';

const AISTUDIO_MCP_URL = process.env.AISTUDIO_MCP_URL || '';
const AISTUDIO_MCP_API_KEY = process.env.AISTUDIO_MCP_API_KEY || '';
const AISTUDIO_MCP_API_KEY_SECRET_ID =
  process.env.AISTUDIO_MCP_API_KEY_SECRET_ID || '';

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
 * Resolve the scoped API key: the direct env var wins (dev + local validation);
 * otherwise read it from Secrets Manager. Returns the raw `sk-…` string.
 */
async function resolveApiKey() {
  if (AISTUDIO_MCP_API_KEY) return AISTUDIO_MCP_API_KEY;
  if (AISTUDIO_MCP_API_KEY_SECRET_ID) {
    const { SecretsManagerClient, GetSecretValueCommand } =
      requireSecretsManager();
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
    const resp = await client.send(
      new GetSecretValueCommand({ SecretId: AISTUDIO_MCP_API_KEY_SECRET_ID })
    );
    const value = (resp.SecretString || '').trim();
    if (!value) {
      throw new Error(
        `Secret ${AISTUDIO_MCP_API_KEY_SECRET_ID} has no SecretString value`
      );
    }
    return value;
  }
  fail(
    'No API key configured. Set AISTUDIO_MCP_API_KEY (a scoped sk- key holding ' +
      'platform:read) or AISTUDIO_MCP_API_KEY_SECRET_ID. The production agent ' +
      'credential is pending the MCP action-tool work (see SKILL.md).'
  );
  return ''; // unreachable
}

/**
 * Single entry point for every MCP call. Handles auth (bearer sk- key), the
 * JSON-RPC envelope, and uniform error surfacing. Writes the JSON-RPC result to
 * stdout on success; emits a structured error and exits non-zero otherwise.
 *
 *   - method: MCP method name ('tools/call', 'tools/list', etc.)
 *   - params: object — the JSON-RPC params field
 *
 * /api/mcp returns HTTP 200 with a JSON-RPC envelope for tool results AND
 * tool-level errors (insufficient scope, unknown tool). Only auth/rate-limit/
 * parse failures use HTTP status codes; handle both.
 */
async function callMcp(method, params) {
  if (!AISTUDIO_MCP_URL) {
    fail('AISTUDIO_MCP_URL is not set');
  }

  const apiKey = await resolveApiKey();

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
    });
  } catch (err) {
    fail(`Network error calling AI Studio MCP: ${err.message}`, 12);
  }

  if (resp.status === 401) {
    const text = await resp.text().catch(() => '');
    emit({
      status: 'unauthorized',
      message:
        'AI Studio MCP rejected the API key (401). The key must be a valid ' +
        'sk- key holding the platform:read scope.',
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
    // Covers tool-level JSON-RPC errors, incl. "Insufficient scope for tool:
    // describe_capabilities" (the caller's key lacks platform:read) and unknown
    // tool. Surface verbatim; do not retry.
    emit({
      status: 'mcp-error',
      method,
      http_status: resp.status,
      jsonrpc_error: data.error,
    });
    process.exit(12);
  }

  process.stdout.write(JSON.stringify(data.result ?? null) + '\n');
  return data.result ?? null;
}

module.exports = {
  fail,
  emit,
  parseArgs,
  resolveApiKey,
  callMcp,
  AISTUDIO_MCP_URL,
};
