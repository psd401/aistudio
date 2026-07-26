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
 *   APP_BASE_URL                        — Base URL of the AI Studio web app
 *   PLAUD_MCP_URL                       — MCP endpoint (default https://mcp.plaud.ai/mcp)
 *   PLAUD_OAUTH_TOKEN_URL               — token endpoint (default https://mcp.plaud.ai/token)
 */

'use strict';

const {
  getOwnerCredential,
  putOwnerCredential,
  requestAgentBroker,
} = require('../_shared/agent-broker');

const PLAUD_MCP_URL = process.env.PLAUD_MCP_URL || 'https://mcp.plaud.ai/mcp';
const PLAUD_OAUTH_TOKEN_URL =
  process.env.PLAUD_OAUTH_TOKEN_URL || 'https://mcp.plaud.ai/token';
const MCP_PROTOCOL_VERSION = '2025-06-18';

function fail(message, code = 1) {
  process.stderr.write(`psd-plaud: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// argv parser. Unlike psd-workspace (which has no bare subcommand), psd-plaud
// takes a positional subcommand (`whoami`, `list`, …), so positionals are
// COLLECTED into args._ rather than rejected. Flag VALUES are consumed via the
// i++ below, so args._[0] is always the real subcommand — not a flag's value.
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) { args._.push(arg); continue; }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

function rejectAuthorityArgs(args) {
  for (const name of ['user', 'owner_email', 'user_email', 'user_id']) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      fail(`--${name.replace(/_/g, '-')} is not accepted; identity comes from the signed invocation`);
    }
  }
}

/**
 * Per-user Plaud token record, written by the /agent-connect-plaud callback.
 * Shape: { refresh_token, obtained_at, client_id?, scope? }. Returns null when
 * the user hasn't completed consent yet.
 */
async function getUserPlaudRecord() {
  const credential = await getOwnerCredential('plaud');
  if (!credential) return null;
  try {
    return JSON.parse(credential.value);
  } catch {
    throw new Error('Stored Plaud credential is not valid JSON');
  }
}

/** The callback stores the public OAuth client_id with the owner token. */
function getPlaudClientId(record) {
  return record && typeof record.client_id === 'string'
    ? record.client_id
    : null;
}

/**
 * Persist a rotated refresh token back to the user's secret. Plaud may rotate
 * refresh tokens on each exchange; if we don't write the new one back, the
 * next turn's stored token would be stale and force re-consent. The AgentCore
 * trusted web-tier credential broker persists rotated owner-scoped tokens
 * (best-effort); the model-facing runtime has no Secrets Manager access.
 */
async function updateStoredRefreshToken(record, newRefreshToken) {
  if (!newRefreshToken || newRefreshToken === record.refresh_token) return;
  try {
    const next = { ...record, refresh_token: newRefreshToken, obtained_at: new Date().toISOString() };
    await putOwnerCredential('plaud', JSON.stringify(next));
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
async function mintConsentUrl() {
  const data = await requestAgentBroker(
    '/api/agent/consent-link',
    { kind: 'plaud' },
  );
  if (!data.url) throw new Error('Consent-link API returned no URL');
  return data.url;
}

/** Emit a needs-auth payload and exit 10 (psd-rules Rule 9 chat conventions). */
async function emitNeedsAuthAndExit(reason) {
  let consentUrl;
  try { consentUrl = await mintConsentUrl(); }
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
 * Core: auth (refresh-or-mint) → initialize handshake → tools/call. Returns the
 * parsed MCP result object. Emits needs-auth (exit 10) when unauthorized, a
 * structured error + non-zero exit on failure. Does NOT write to stdout — so
 * callers that must keep content OUT of the agent's context (digest) can use it.
 */
async function invokeTool(toolName, toolArgs) {
  const record = await getUserPlaudRecord();
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit('no Plaud token stored for this user yet');
  }
  const clientId = await getPlaudClientId(record);
  if (!clientId) fail('Plaud OAuth client_id is missing from the owner credential');

  let auth;
  try {
    auth = await refreshPlaudAccessToken(record.refresh_token, clientId);
  } catch (err) {
    if (err.code === 'invalid_grant' || err.code === 'invalid_request' || err.code === 'unauthorized_client') {
      await emitNeedsAuthAndExit(`stored Plaud token rejected: ${err.code}`);
    }
    fail(`Plaud token refresh failed: ${err.message}`);
  }
  await updateStoredRefreshToken(record, auth.refresh_token);

  // 1. initialize handshake (captures the session id if the server is stateful)
  const initId = ++_rpcId;
  const initResp = await mcpPost(auth.access_token, {
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'psd-plaud', version: '1' },
    },
  });
  if (initResp.status === 401) await emitNeedsAuthAndExit('Plaud MCP rejected token (401)');
  if (!initResp.ok) {
    const t = await initResp.text().catch(() => '');
    fail(`Plaud MCP initialize HTTP ${initResp.status}: ${t.slice(0, 400)}`, 12);
  }
  const sessionId = initResp.headers.get('mcp-session-id') || null;
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

  if (resp.status === 401) await emitNeedsAuthAndExit('Plaud MCP rejected token (401)');
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
  // Per the MCP spec, a tool-level failure is a JSON-RPC SUCCESS whose result
  // carries isError:true with the error text in result.content — it is NOT
  // surfaced via the top-level msg.error field checked above. Without this
  // guard the error text flows back to callers (e.g. digestRecording pipes it
  // into psd-summarize) as if it were real tool content.
  if (msg.result && msg.result.isError) {
    // Truncate like the HTTP-failure branches above — this text originates
    // from the upstream MCP server, and digestRecording calls invokeTool
    // specifically so raw tool content never reaches stdout uncontrolled;
    // an error payload shouldn't be a wider bypass of that than a real HTTP
    // failure already is.
    const detail = extractTextFromResult(msg.result);
    emit({ status: 'mcp-error', tool: toolName, tool_error: detail ? detail.slice(0, 400) : null });
    process.exit(12);
  }
  return msg.result ?? null;
}

/** Invoke a tool and write the raw result to stdout (surfaced to the model). */
async function callTool(toolName, toolArgs) {
  const result = await invokeTool(toolName, toolArgs);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

/** Concatenate the text blocks of an MCP tools/call result. */
function extractTextFromResult(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * digest — fetch a recording's transcript and return ONLY a records-safe
 * summary. The raw transcript is fetched here and piped to psd-summarize on
 * stdin; it NEVER touches this skill's stdout, so it never enters the agent's
 * context, chat, memory, logs, or telemetry. This is the DEFAULT way to get
 * recording content (raw `transcript` is the explicit exception).
 */
async function digestRecording(id, opts) {
  const result = await invokeTool('get_transcript', { file_id: id });
  const transcript = extractTextFromResult(result);
  if (!transcript) {
    emit({ status: 'empty', message: 'No transcript text is available for this recording.' });
    process.exit(0);
  }
  const { spawnSync } = require('node:child_process');
  const args = ['/opt/psd-skills/psd-summarize/run.js', '--context', 'Plaud voice recording transcript'];
  if (opts.profiles) args.push('--profiles', opts.profiles);
  if (opts.output) args.push('--output', opts.output);
  if (opts.length) args.push('--length', opts.length);
  const res = spawnSync('node', args, {
    input: transcript, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    fail(`summarization failed (exit ${res.status}): ${(res.stderr || '').slice(0, 300)}`, 12);
  }
  // psd-summarize emits {status:'ok', summary}. Only the summary leaves here.
  process.stdout.write((res.stdout || '').trim() + '\n');
}

/** List the server's tools (for `tools` subcommand / schema introspection). */
async function listTools() {
  const record = await getUserPlaudRecord();
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit('no Plaud token stored for this user yet');
  }
  const clientId = await getPlaudClientId(record);
  if (!clientId) fail('Plaud OAuth client_id is not configured');
  let auth;
  try { auth = await refreshPlaudAccessToken(record.refresh_token, clientId); }
  catch (err) {
    if (err.code === 'invalid_grant') await emitNeedsAuthAndExit('token rejected');
    fail(`Plaud token refresh failed: ${err.message}`);
  }
  await updateStoredRefreshToken(record, auth.refresh_token);
  const initId = ++_rpcId;
  const initResp = await mcpPost(auth.access_token, {
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'psd-plaud', version: '1' } },
  });
  if (initResp.status === 401) await emitNeedsAuthAndExit('Plaud MCP rejected token (401)');
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
  fail, emit, parseArgs, rejectAuthorityArgs,
  getUserPlaudRecord, refreshPlaudAccessToken, mintConsentUrl,
  emitNeedsAuthAndExit, callTool, digestRecording, listTools,
  PLAUD_MCP_URL,
};
