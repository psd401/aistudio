/**
 * MCP-over-SSE client for the PSD Agent Gateway (n8n "MCP Server Trigger").
 *
 * The gateway exposes curated tools (schema, list employees, submit evaluation)
 * backed by a shared validate -> branded PDF -> Documenso pipeline. Transport is
 * the MCP HTTP+SSE binding:
 *
 *   1. GET  {SSE_URL}                 (Authorization: Bearer <token>, Accept: text/event-stream)
 *      -> server holds the stream open and sends `event: endpoint`
 *         whose data is the URL to POST JSON-RPC messages to
 *         (`.../messages?sessionId=<id>`).
 *   2. POST {endpoint}                (Authorization: Bearer <token>, JSON body)
 *      -> returns 202 Accepted; the JSON-RPC RESPONSE arrives back on the SSE
 *         stream as `event: message`, correlated by JSON-RPC id.
 *
 * Zero npm dependencies: native fetch streaming only (Node 20+), mirroring the
 * dependency-free pattern of psd-aistudio/psd-data. @aws-sdk/client-secrets-manager
 * (used to read the {url, token} config secret) is resolved at runtime from
 * psd-workspace's node_modules so this skill adds no image dependency of its own.
 *
 * Designed for extension: this client is form-agnostic (connect + callTool over
 * whatever tools the gateway advertises), so transfer/timesheet tool families
 * can be added to the same gateway and driven by new run.js subcommands without
 * touching the transport.
 *
 * Issue #1230.
 */

'use strict';

// The five valid classified-evaluation rating values (exact strings the gateway
// validates against). Exported for client-side pre-validation + run.js help text.
const RATING_VALUES = ['Requires Improvement', 'Fair', 'Satisfactory', 'Good', 'Outstanding'];

// --- Config resolution ------------------------------------------------------

// Env contract (wired by infra/lib/agent-platform-stack.ts + deploy):
//   AGENT_GATEWAY_CONFIG_SECRET_ID  — Secrets Manager id of ONE JSON secret
//                                     shaped {"url":"…","token":"…"} holding the
//                                     n8n MCP Server Trigger /sse endpoint AND the
//                                     Bearer token (ECS/AgentCore). Defaults to
//                                     psd-agent/{env}/agent-gateway. Both live in
//                                     this secret (NOT in the public repo / not a
//                                     CDK context flag).
//   AGENT_GATEWAY_SSE_URL           — direct URL override (local dev / tests).
//   AGENT_GATEWAY_TOKEN             — direct Bearer token override (local/dev).
// Read at call time (not module load) so behavior tracks the live environment
// and is unit-testable.

// Indirection seam so unit tests can stub the AWS SDK / fetch without mocking
// `node:` builtins.
const _internals = {
  requireSecretsManager() {
    try {
      return require('/opt/psd-skills/psd-workspace/node_modules/@aws-sdk/client-secrets-manager');
    } catch {
      return require('@aws-sdk/client-secrets-manager');
    }
  },
  fetch: (...args) => fetch(...args),
};

/** Default config secret id: psd-agent/{env}/agent-gateway (env = ENVIRONMENT). */
function defaultConfigSecretId() {
  const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENVIRONMENT || 'dev';
  return `psd-agent/${env}/agent-gateway`;
}

/**
 * Read the consolidated `{url, token}` config secret. Returns the parsed object,
 * or null when the secret is absent / empty (treated as "not configured" so the
 * caller fails closed with exit 11 rather than a transport error). Throws a
 * `GatewayConfigError` when the secret exists but is not valid JSON.
 */
async function readConfigSecret(secretId) {
  const { SecretsManagerClient, GetSecretValueCommand } = _internals.requireSecretsManager();
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  let resp;
  try {
    resp = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  } catch (err) {
    // A missing secret means the gateway isn't wired in this environment yet —
    // fail closed (exit 11) rather than surfacing an SM error as transport (12).
    if (err && (err.name === 'ResourceNotFoundException' || err.__type === 'ResourceNotFoundException')) {
      return null;
    }
    throw err;
  }
  const raw = (resp.SecretString || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayConfigError(
      `Secret ${secretId} is not valid JSON (expected {"url":"…","token":"…"}).`
    );
  }
  return {
    url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
    token: typeof parsed.token === 'string' ? parsed.token.trim() : '',
  };
}

/**
 * Resolve the gateway URL + Bearer token. Direct env vars
 * (AGENT_GATEWAY_SSE_URL / AGENT_GATEWAY_TOKEN) win per-field for local dev; both
 * otherwise come from the consolidated `{url, token}` config secret. Returns
 * `{ url, token }` or throws a `GatewayConfigError` (mapped to exit 11 by run.js)
 * when the URL or token is not configured — the values are owned by the n8n side
 * and wired per environment; until then the skill fails closed with an
 * actionable message rather than silently.
 */
async function resolveConfig() {
  const envUrl = (process.env.AGENT_GATEWAY_SSE_URL || '').trim();
  const envToken = (process.env.AGENT_GATEWAY_TOKEN || '').trim();

  // Fast path: both provided directly (local dev / tests) — skip Secrets Manager.
  if (envUrl && envToken) {
    return { url: envUrl, token: envToken };
  }

  let url = envUrl;
  let token = envToken;
  const secretId = (process.env.AGENT_GATEWAY_CONFIG_SECRET_ID || '').trim() || defaultConfigSecretId();
  const cfg = await readConfigSecret(secretId);
  if (cfg) {
    url = url || cfg.url;
    token = token || cfg.token;
  }

  if (!url) {
    throw new GatewayConfigError(
      `The PSD Agent Gateway is not configured (no URL in AGENT_GATEWAY_SSE_URL ` +
        `or the ${secretId} secret). It must be wired per environment before ` +
        `classified evaluations can run.`
    );
  }
  if (!token) {
    throw new GatewayConfigError(
      `The PSD Agent Gateway bearer token is not configured (no token in ` +
        `AGENT_GATEWAY_TOKEN or the ${secretId} secret).`
    );
  }
  return { url, token };
}

class GatewayConfigError extends Error {}
class GatewayTransportError extends Error {}
/** A JSON-RPC error returned by the gateway (surfaced verbatim to the agent). */
class GatewayToolError extends Error {
  constructor(message, rpcError) {
    super(message);
    this.rpcError = rpcError;
  }
}

// --- SSE parsing (pure) -----------------------------------------------------

/**
 * Incrementally parse SSE text into complete frames. Frames are separated by a
 * blank line; within a frame, `event:` sets the type and one-or-more `data:`
 * lines are joined with `\n`. Lines starting with `:` are comments (keepalives)
 * and ignored. Returns `{ frames, rest }` — `rest` is the trailing partial
 * frame to prepend to the next chunk.
 */
function parseSseBuffer(buffer) {
  const frames = [];
  // Normalize CRLF -> LF so splitting on the blank-line delimiter is uniform.
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop(); // trailing (possibly incomplete) frame
  for (const part of parts) {
    if (!part.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of part.split('\n')) {
      if (line.startsWith(':')) continue; // comment / keepalive
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        // A single leading space after the colon is stripped per the SSE spec.
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    frames.push({ event, data: dataLines.join('\n') });
  }
  return { frames, rest };
}

/**
 * Resolve the endpoint URL announced by the SSE `endpoint` event. n8n emits a
 * path (e.g. `/messages?sessionId=abc`); resolve it against the SSE URL's
 * origin. An absolute URL is returned as-is.
 */
function resolveEndpointUrl(sseUrl, endpointData) {
  return new URL(endpointData, sseUrl).toString();
}

// --- MCP SSE client ---------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

class GatewayClient {
  /**
   * @param {object} opts
   * @param {string} opts.url    SSE endpoint URL.
   * @param {string} opts.token  Bearer token.
   * @param {Function} [opts.fetchImpl]  fetch seam (defaults to native fetch).
   */
  constructor({ url, token, fetchImpl = _internals.fetch,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.controller = new AbortController();
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.endpointUrl = null;
    this._endpointWaiters = [];
    this._closed = false;
    this._readLoop = null;
  }

  authHeaders(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /** Open the SSE stream and wait until the gateway announces its message endpoint. */
  async connect() {
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: this.authHeaders({ Accept: 'text/event-stream' }),
        signal: this.controller.signal,
      });
    } catch (err) {
      throw new GatewayTransportError(`Failed to open gateway SSE stream: ${err.message}`);
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new GatewayTransportError(
        `Gateway SSE stream returned HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`
      );
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new GatewayTransportError('Gateway SSE response has no readable body stream.');
    }
    // Drive the read loop in the background; it resolves endpoint + pending calls.
    this._readLoop = this._consume(res.body.getReader()).catch((err) => {
      this._failAll(err instanceof Error ? err : new Error(String(err)));
    });
    await this._waitForEndpoint();
  }

  async _consume(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        this._failAll(new GatewayTransportError('Gateway SSE stream closed unexpectedly.'));
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const frame of frames) this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    if (frame.event === 'endpoint') {
      try {
        this.endpointUrl = resolveEndpointUrl(this.url, frame.data.trim());
      } catch (err) {
        this._failAll(new GatewayTransportError(`Gateway announced an invalid endpoint: ${err.message}`));
        return;
      }
      const waiters = this._endpointWaiters;
      this._endpointWaiters = [];
      for (const w of waiters) w.resolve();
      return;
    }
    // `message` (and any other data-bearing event): parse a JSON-RPC response.
    let msg;
    try {
      msg = JSON.parse(frame.data);
    } catch {
      return; // ignore non-JSON frames (e.g. gateway keepalive text)
    }
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve(msg);
    }
    // Notifications (no id) are ignored — this client makes request/response calls only.
  }

  _waitForEndpoint() {
    if (this.endpointUrl) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter and reject on connect timeout.
        this._endpointWaiters = this._endpointWaiters.filter((w) => w.resolve !== wrapped);
        reject(new GatewayTransportError(
          `Gateway did not announce its message endpoint within ${this.connectTimeoutMs / 1000}s.`
        ));
      }, this.connectTimeoutMs);
      const wrapped = () => { clearTimeout(timer); resolve(); };
      this._endpointWaiters.push({ resolve: wrapped, reject });
    });
  }

  _failAll(err) {
    for (const [, { reject }] of this.pending) reject(err);
    this.pending.clear();
    const waiters = this._endpointWaiters;
    this._endpointWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  /** Send a JSON-RPC request and await its correlated response from the SSE stream. */
  async request(method, params) {
    if (!this.endpointUrl) await this._waitForEndpoint();
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method, params: params || {} };

    // Register the pending waiter BEFORE POSTing so a fast SSE response can never
    // race ahead of registration. `settle` clears the timeout on every exit path
    // (success, tool error, or POST failure) — no dangling timers / unhandled
    // rejections.
    let settle;
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayTransportError(`Gateway did not respond to ${method} within ${this.requestTimeoutMs / 1000}s.`));
      }, this.requestTimeoutMs);
      settle = {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.pending.set(id, settle);
    });

    let postRes;
    try {
      postRes = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: this.controller.signal,
      });
    } catch (err) {
      this.pending.delete(id);
      settle.reject(new GatewayTransportError(`Failed to POST ${method} to gateway: ${err.message}`));
      return responsePromise; // rejects with the error above (timer cleared)
    }
    // The response body arrives on the SSE stream; the POST itself should be
    // 2xx (typically 202 Accepted). A non-2xx POST is a transport failure.
    if (!postRes.ok) {
      this.pending.delete(id);
      const text = await safeText(postRes);
      settle.reject(new GatewayTransportError(
        `Gateway rejected ${method} (HTTP ${postRes.status})${text ? `: ${text.slice(0, 300)}` : ''}`
      ));
      return responsePromise; // rejects with the error above (timer cleared)
    }

    const msg = await responsePromise;
    if (msg.error) {
      throw new GatewayToolError(
        typeof msg.error.message === 'string' ? msg.error.message : `Gateway error on ${method}`,
        msg.error
      );
    }
    return msg.result;
  }

  /** Send a JSON-RPC notification (no response expected). */
  async notify(method, params) {
    if (!this.endpointUrl) await this._waitForEndpoint();
    const body = { jsonrpc: '2.0', method, params: params || {} };
    try {
      await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: this.controller.signal,
      });
    } catch {
      // Notifications are best-effort; a failure here surfaces on the next request.
    }
  }

  /** Run the MCP initialize handshake (required once per SSE session). */
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'psd-classified-evaluation', version: '1.0.0' },
    });
    await this.notify('notifications/initialized', {});
    return result;
  }

  /**
   * Call a gateway tool and unwrap its MCP result envelope
   * (`{ content: [{ type:'text', text }], isError? }`). Returns
   * `{ isError, data }` where `data` is the parsed JSON payload (or raw text).
   */
  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} });
    return unwrapToolResult(result);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try { this.controller.abort(); } catch { /* already aborted */ }
  }
}

/** Unwrap an MCP tool-call result envelope into `{ isError, data }`. */
function unwrapToolResult(result) {
  const isError = !!(result && result.isError);
  const first = result && Array.isArray(result.content) ? result.content[0] : null;
  const text = first && typeof first.text === 'string' ? first.text : null;
  let data;
  if (text !== null) {
    try { data = JSON.parse(text); } catch { data = text; }
  } else {
    data = result ?? null;
  }
  return { isError, data };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/**
 * Convenience: open a session, initialize, call one tool, and close — the
 * one-shot lifecycle every run.js subcommand uses. Each skill invocation is an
 * independent process with its own SSE session, so state never leaks between
 * turns.
 */
async function callGatewayTool(toolName, toolArgs, { fetchImpl } = {}) {
  const { url, token } = await resolveConfig();
  const client = new GatewayClient({ url, token, ...(fetchImpl ? { fetchImpl } : {}) });
  try {
    await client.connect();
    await client.initialize();
    return await client.callTool(toolName, toolArgs);
  } finally {
    client.close();
  }
}

module.exports = {
  RATING_VALUES,
  resolveConfig,
  parseSseBuffer,
  resolveEndpointUrl,
  unwrapToolResult,
  GatewayClient,
  GatewayConfigError,
  GatewayTransportError,
  GatewayToolError,
  callGatewayTool,
  _internals,
};
