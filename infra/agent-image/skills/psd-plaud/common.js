/**
 * Shared helpers for the psd-plaud OpenClaw skill.
 *
 * Authenticates the caller to Plaud's hosted MCP server
 * (https://mcp.plaud.ai/mcp) using a per-user OAuth refresh token, then speaks
 * the MCP Streamable-HTTP protocol directly (like psd-data does for its own MCP
 * server) so each caller only ever touches their own Plaud recordings.
 *
 * We deliberately do NOT use OpenClaw's built-in MCP client config: that is a
 * single global registry per gateway with no per-user token isolation, which
 * would share one Plaud account across all users. A per-user skill client keeps
 * each of the N users' tokens isolated (stored in Secrets Manager by email).
 *
 * Auth is a standard OAuth 2.1 flow (verified live against Plaud's server):
 *   - AS metadata: https://mcp.plaud.ai/.well-known/oauth-authorization-server
 *   - authorization_code + refresh_token grants, PKCE S256, public client (no
 *     secret). The one-time browser consent is driven by AI Studio's
 *     /agent-connect-plaud flow; this skill only does headless refresh.
 *
 * Environment contract (set by infra/lib/agent-platform-stack.ts):
 *   AWS_REGION                          — e.g. us-east-1
 *   ENVIRONMENT                         — dev/staging/prod
 *   APP_BASE_URL                        — Base URL of the AI Studio web app
 *   AGENT_INTERNAL_API_KEY_SECRET_ID    — Secrets Manager ID for shared secret
 *   PLAUD_MCP_URL                       — MCP endpoint (default https://mcp.plaud.ai/mcp)
 *   PLAUD_OAUTH_TOKEN_URL               — token endpoint (default https://mcp.plaud.ai/token)
 *   PLAUD_OAUTH_SECRET_ID               — SM id holding the registered {client_id}
 */

'use strict';

// Reuse psd-workspace's already-installed AWS SDK copy (keeps image file-count
// flat — same rationale as psd-data). This skill ships no node_modules.
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require('/opt/psd-skills/psd-workspace/node_modules/@aws-sdk/client-secrets-manager');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const AGENT_INTERNAL_API_KEY_SECRET_ID =
  process.env.AGENT_INTERNAL_API_KEY_SECRET_ID ||
  `psd-agent/${ENVIRONMENT}/internal-api-key`;
const PLAUD_MCP_URL = process.env.PLAUD_MCP_URL || 'https://mcp.plaud.ai/mcp';
const PLAUD_OAUTH_TOKEN_URL =
  process.env.PLAUD_OAUTH_TOKEN_URL || 'https://mcp.plaud.ai/token';
const PLAUD_OAUTH_SECRET_ID =
  process.env.PLAUD_OAUTH_SECRET_ID || `psd-agent/${ENVIRONMENT}/plaud-oauth-client`;
const MCP_PROTOCOL_VERSION = '2025-06-18';

const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;

const smClient = new SecretsManagerClient({ region: REGION });

function fail(message, code = 1) {
  process.stderr.write(`psd-plaud: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Same argv parser convention as psd-data/psd-workspace.
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  if (typeof email !== 'string' || !SAFE_EMAIL_RE.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}

// Per-user Plaud token slot. Same convention as the Google/Cognito slots;
// covered by the existing psd-agent-creds/{env}/* IAM grants (no new IAM).
function plaudTokenSecretId(email) {
  return `psd-agent-creds/${ENVIRONMENT}/user/${email}/plaud`;
}

async function getSecretJson(secretId) {
  const resp = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!resp.SecretString) throw new Error(`Secret ${secretId} has no SecretString value`);
  try { return JSON.parse(resp.SecretString); }
  catch (err) { throw new Error(`Secret ${secretId} is not valid JSON: ${err.message}`); }
}

async function getSecretString(secretId) {
  const resp = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  return resp.SecretString || null;
}

/**
 * Per-user Plaud token record, written by the /agent-connect-plaud callback.
 * Shape: { refresh_token, obtained_at, client_id?, scope? }. Returns null when
 * the user hasn't completed consent yet.
 */
async function getUserPlaudRecord(email) {
  try { return await getSecretJson(plaudTokenSecretId(email)); }
  catch (err) {
    if (err && err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

/** The registered public OAuth client_id (from Dynamic Client Registration). */
async function getPlaudClientId(record) {
  if (record && record.client_id) return record.client_id;
  try {
    const creds = await getSecretJson(PLAUD_OAUTH_SECRET_ID);
    return creds.client_id || null;
  } catch { return null; }
}

/**
 * Persist a rotated refresh token back to the user's secret. Plaud may rotate
 * refresh tokens on each exchange; if we don't write the new one back, the
 * next turn's stored token would be stale and force re-consent. The AgentCore
 * role holds PutSecretValue on psd-agent-creds/{env}/user/* (best-effort).
 */
async function updateStoredRefreshToken(email, record, newRefreshToken) {
  if (!newRefreshToken || newRefreshToken === record.refresh_token) return;
  try {
    const next = { ...record, refresh_token: newRefreshToken, obtained_at: new Date().toISOString() };
    await smClient.send(new PutSecretValueCommand({
      SecretId: plaudTokenSecretId(email),
      SecretString: JSON.stringify(next),
    }));
  } catch (err) {
    // Non-fatal: the access token we already have is valid for this turn.
    process.stderr.write(`psd-plaud: refresh-token rotation write failed (continuing): ${err.message}\n`);
  }
}

/**
 * Exchange the stored refresh token for a fresh access token at Plaud's token
 * endpoint. Public client (no secret) + refresh_token grant, form-encoded.
 * Throws with code 'invalid_grant' when the refresh token is revoked/expired.
 */
async function refreshPlaudAccessToken(refreshToken, clientId) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const resp = await fetch(PLAUD_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Plaud token refresh failed: ${resp.status} ${data.error || ''}`);
    err.code = data.error || `http_${resp.status}`;
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null, // present iff the server rotates
    expires_in: data.expires_in || null,
  };
}

/** Mint a one-time consent URL (chat → browser) via AI Studio. */
async function mintConsentUrl(ownerEmail) {
  if (!APP_BASE_URL) throw new Error('APP_BASE_URL env var not set — cannot mint consent URL');
  const apiKey = await getSecretString(AGENT_INTERNAL_API_KEY_SECRET_ID);
  if (!apiKey) throw new Error(`Internal API key secret ${AGENT_INTERNAL_API_KEY_SECRET_ID} is empty`);
  const resp = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}/api/agent/consent-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ownerEmail, kind: 'plaud' }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.url) throw new Error(`Consent-link API failed: ${resp.status} ${data.error || ''}`);
  return data.url;
}

/** Emit a needs-auth payload and exit 10 (psd-rules Rule 9 chat conventions). */
async function emitNeedsAuthAndExit(ownerEmail, reason) {
  let consentUrl;
  try { consentUrl = await mintConsentUrl(ownerEmail); }
  catch (err) { fail(`Unable to mint consent URL: ${err.message}`); }
  emit({
    status: 'needs-auth',
    kind: 'plaud',
    reason,
    consent_url: consentUrl,
    consent_chat_hyperlink: `<${consentUrl}|Connect your Plaud account>`,
    message:
      'Paste consent_chat_hyperlink on its own line, no surrounding markdown. ' +
      'Then on a separate line: "Click the link to connect your Plaud account so I can read your recordings."',
  });
  process.exit(10);
}

/**
 * Parse a Streamable-HTTP MCP response body which may be either a single JSON
 * object (Content-Type application/json) or an SSE stream (text/event-stream)
 * carrying one or more `data:` JSON-RPC messages. Return the JSON-RPC message
 * whose `id` matches, or the last message seen.
 */
function parseMcpResponse(contentType, text, wantId) {
  if (contentType.includes('text/event-stream')) {
    let last = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const msg = JSON.parse(payload);
        if (msg && msg.id === wantId) return msg;
        last = msg;
      } catch { /* skip non-JSON keepalive lines */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

let _rpcId = 0;
async function mcpPost(accessToken, message, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const resp = await fetch(PLAUD_MCP_URL, {
    method: 'POST', headers, body: JSON.stringify(message),
  });
  return resp;
}

/**
 * One MCP tool call, end to end: auth (refresh-or-mint) → initialize handshake
 * → tools/call. Writes the tool result to stdout on success; emits needs-auth
 * (exit 10) when unauthorized; structured error + non-zero exit otherwise.
 */
async function callTool(toolName, toolArgs, ownerEmail) {
  const record = await getUserPlaudRecord(ownerEmail);
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit(ownerEmail, 'no Plaud token stored for this user yet');
  }
  const clientId = await getPlaudClientId(record);
  if (!clientId) fail('Plaud OAuth client_id is not configured (PLAUD_OAUTH_SECRET_ID)');

  let auth;
  try {
    auth = await refreshPlaudAccessToken(record.refresh_token, clientId);
  } catch (err) {
    if (err.code === 'invalid_grant' || err.code === 'invalid_request' || err.code === 'unauthorized_client') {
      await emitNeedsAuthAndExit(ownerEmail, `stored Plaud token rejected: ${err.code}`);
    }
    fail(`Plaud token refresh failed: ${err.message}`);
  }
  await updateStoredRefreshToken(ownerEmail, record, auth.refresh_token);

  // 1. initialize handshake (captures the session id if the server is stateful)
  const initId = ++_rpcId;
  let initResp = await mcpPost(auth.access_token, {
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'psd-plaud', version: '1' },
    },
  });
  if (initResp.status === 401) await emitNeedsAuthAndExit(ownerEmail, 'Plaud MCP rejected token (401)');
  if (!initResp.ok) {
    const t = await initResp.text().catch(() => '');
    fail(`Plaud MCP initialize HTTP ${initResp.status}: ${t.slice(0, 400)}`, 12);
  }
  const sessionId = initResp.headers.get('mcp-session-id') || null;
  // Drain the initialize body (result not needed) and send the initialized note.
  await initResp.text().catch(() => '');
  try {
    await mcpPost(auth.access_token,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId);
  } catch { /* best-effort; some servers don't require it */ }

  // 2. tools/call
  const callId = ++_rpcId;
  const resp = await mcpPost(auth.access_token, {
    jsonrpc: '2.0', id: callId, method: 'tools/call',
    params: { name: toolName, arguments: toolArgs || {} },
  }, sessionId);

  if (resp.status === 401) await emitNeedsAuthAndExit(ownerEmail, 'Plaud MCP rejected token (401)');
  if (resp.status === 429) {
    emit({ status: 'rate-limited', message: 'Plaud is rate-limiting requests. Wait a moment and retry.' });
    process.exit(14);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    fail(`Plaud MCP tools/call HTTP ${resp.status}: ${t.slice(0, 400)}`, 12);
  }
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  const msg = parseMcpResponse(ct, text, callId);
  if (!msg) fail('Plaud MCP returned an unparseable response', 12);
  if (msg.error) {
    emit({ status: 'mcp-error', tool: toolName, jsonrpc_error: msg.error });
    process.exit(12);
  }
  // MCP tools/call result: { content: [...], isError? }. Emit as-is; run.js
  // is responsible for surfacing text content to the model.
  process.stdout.write(JSON.stringify(msg.result ?? null) + '\n');
  return msg.result ?? null;
}

/** List the server's tools (for `tools` subcommand / schema introspection). */
async function listTools(ownerEmail) {
  const record = await getUserPlaudRecord(ownerEmail);
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit(ownerEmail, 'no Plaud token stored for this user yet');
  }
  const clientId = await getPlaudClientId(record);
  if (!clientId) fail('Plaud OAuth client_id is not configured');
  let auth;
  try { auth = await refreshPlaudAccessToken(record.refresh_token, clientId); }
  catch (err) {
    if (err.code === 'invalid_grant') await emitNeedsAuthAndExit(ownerEmail, 'token rejected');
    fail(`Plaud token refresh failed: ${err.message}`);
  }
  await updateStoredRefreshToken(ownerEmail, record, auth.refresh_token);
  const initId = ++_rpcId;
  const initResp = await mcpPost(auth.access_token, {
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'psd-plaud', version: '1' } },
  });
  if (initResp.status === 401) await emitNeedsAuthAndExit(ownerEmail, 'Plaud MCP rejected token (401)');
  const sessionId = initResp.headers.get('mcp-session-id') || null;
  await initResp.text().catch(() => '');
  const listId = ++_rpcId;
  const resp = await mcpPost(auth.access_token, { jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} }, sessionId);
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  const msg = parseMcpResponse(ct, text, listId);
  if (!msg || msg.error) fail(`tools/list failed: ${JSON.stringify(msg && msg.error)}`, 12);
  process.stdout.write(JSON.stringify(msg.result ?? null) + '\n');
  return msg.result ?? null;
}

module.exports = {
  fail, emit, parseArgs, validateUserEmail,
  getUserPlaudRecord, refreshPlaudAccessToken, mintConsentUrl,
  emitNeedsAuthAndExit, callTool, listTools, plaudTokenSecretId,
  PLAUD_MCP_URL,
};
