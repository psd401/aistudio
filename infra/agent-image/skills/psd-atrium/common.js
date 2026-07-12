/**
 * Shared helpers for the psd-atrium OpenClaw skill (Issue #1055 Path 2).
 *
 * Thin REST client for AI Studio's Atrium content surface (`/api/v1/content/*`).
 * Like psd-aistudio (discovery), this authenticates with a single scoped API key
 * (`sk-…`) — but a CONTENT key holding `content:*` data scopes, not the read-only
 * `platform:read` catalog key. The agent therefore works **version-based**: reads
 * return the last saved version, writes create a new version. It acts as the KEY
 * OWNER's identity (visibility-gated by that user's roles) — NOT per-caller
 * delegation. Per-user delegated tokens (`/api/v1/agents/delegated-token`) are a
 * designed later phase and are not provisioned yet (see SKILL.md + the design doc
 * docs/features/atrium-agent-access.md).
 *
 * Environment contract (set by infra/lib/agent-platform-stack.ts + deploy):
 *   APP_BASE_URL                        — deployed AI Studio base (…/api/v1/content
 *                                         is derived from it).
 *   AISTUDIO_CONTENT_API_URL            — explicit override of the /api/v1/content
 *                                         base (tests / split deployments).
 *   AISTUDIO_MCP_URL                    — the discovery skill's …/api/mcp URL; used
 *                                         only as a last-resort base derivation.
 *   AISTUDIO_CONTENT_API_KEY            — scoped `sk-…` content key. Direct.
 *   AISTUDIO_CONTENT_API_KEY_SECRET_ID  — Secrets Manager id holding the `sk-…`
 *                                         content key (used when the env var is
 *                                         absent).
 */

'use strict';

const APP_BASE_URL = process.env.APP_BASE_URL || '';
const AISTUDIO_CONTENT_API_URL = process.env.AISTUDIO_CONTENT_API_URL || '';
const AISTUDIO_MCP_URL = process.env.AISTUDIO_MCP_URL || '';
const AISTUDIO_CONTENT_API_KEY = process.env.AISTUDIO_CONTENT_API_KEY || '';
const AISTUDIO_CONTENT_API_KEY_SECRET_ID =
  process.env.AISTUDIO_CONTENT_API_KEY_SECRET_ID || '';

/** Per-request timeout (ms) so a hung upstream surfaces as a clear error instead
 *  of hanging the CLI invocation. Overridable via AISTUDIO_CONTENT_API_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AISTUDIO_CONTENT_API_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
})();

function fail(message, code = 1) {
  process.stderr.write(`psd-atrium: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * base64-encode a content body for transit. AI Studio's edge WAF blocks any
 * request body that looks like reflected XSS (`<script>`, `<style>`, `style="…"`,
 * `onerror=`) via the managed CrossSiteScripting_BODY rule — which is exactly the
 * markup a real Atrium ARTIFACT carries — returning a bare 403 with no detail.
 * base64's alphabet (`[A-Za-z0-9+/=]`) contains none of those characters, so an
 * encoded body is inert to the WAF; the server decodes it (via the request's
 * `codeEncoding: "base64"` flag) BEFORE screening/size caps. JS/CSS artifact code
 * is therefore fully supported — this makes it opaque in transit, not stripped.
 */
function encodeContentBody(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

/**
 * Return a REST write body with its `body` field base64-encoded and
 * `codeEncoding: "base64"` set, so <script>/<style>-bearing content survives the
 * edge WAF. A no-op when there is no body to send (e.g. a metadata-only create),
 * so an empty document is posted unchanged.
 */
function withEncodedBody(body) {
  if (!body || typeof body.body !== 'string' || body.body.length === 0) {
    return body;
  }
  return { ...body, body: encodeContentBody(body.body), codeEncoding: 'base64' };
}

/**
 * Minimal long-form argv parser. `--foo bar` and `--foo` (boolean) supported;
 * dashes in key names become underscores. Mirrors psd-aistudio/psd-data.
 */
function parseArgs(argv, startIndex = 2) {
  const args = {};
  for (let i = startIndex; i < argv.length; i++) {
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
 * Resolve the `/api/v1/content` base URL. Explicit override wins (tests / split
 * deployments); otherwise derive from the deployed app base; last resort, strip
 * the discovery skill's `…/api/mcp` suffix. Returns '' when nothing is set so the
 * caller can fail with a clear config error.
 */
function resolveContentBaseUrl() {
  const strip = (u) => u.replace(/\/+$/, '');
  if (AISTUDIO_CONTENT_API_URL) return strip(AISTUDIO_CONTENT_API_URL);
  if (APP_BASE_URL) return `${strip(APP_BASE_URL)}/api/v1/content`;
  if (AISTUDIO_MCP_URL) {
    const withoutMcp = strip(AISTUDIO_MCP_URL).replace(/\/api\/mcp$/, '');
    if (withoutMcp !== strip(AISTUDIO_MCP_URL)) {
      return `${withoutMcp}/api/v1/content`;
    }
  }
  return '';
}

/**
 * Load the AWS SDK the same way psd-aistudio/psd-data do — prefer psd-workspace's
 * already-installed copy so this skill adds no image dependency, falling back to a
 * bare require for local/testing. Only reached when the secret path is used.
 */
function requireSecretsManager() {
  try {
    return require('/opt/psd-skills/psd-workspace/node_modules/@aws-sdk/client-secrets-manager');
  } catch {
    return require('@aws-sdk/client-secrets-manager');
  }
}

/**
 * Resolve the scoped content API key: the direct env var wins (dev + local
 * validation); otherwise read it from Secrets Manager. Returns the raw `sk-…`
 * string.
 */
async function resolveApiKey() {
  if (AISTUDIO_CONTENT_API_KEY) return AISTUDIO_CONTENT_API_KEY;
  if (AISTUDIO_CONTENT_API_KEY_SECRET_ID) {
    let value;
    try {
      const { SecretsManagerClient, GetSecretValueCommand } =
        requireSecretsManager();
      const client = new SecretsManagerClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });
      const resp = await client.send(
        new GetSecretValueCommand({
          SecretId: AISTUDIO_CONTENT_API_KEY_SECRET_ID,
        })
      );
      value = (resp.SecretString || '').trim();
    } catch (err) {
      // A retrieval failure (permission / decryption / network) is an infra
      // error, not a malformed invocation — surface it clearly (exit 12).
      fail(
        `Failed to retrieve content API key from Secrets Manager ` +
          `(${AISTUDIO_CONTENT_API_KEY_SECRET_ID}): ${err.message}`,
        12
      );
    }
    // NOTE: `fail()` calls `process.exit()`, which never returns — so if the
    // catch above ran (retrieval error), execution stopped there and we never
    // reach this line. This guard only handles the retrieval-SUCCEEDED-but-empty
    // case (a real, distinct outcome), not a double-fail after the catch.
    if (!value) {
      fail(
        `Secret ${AISTUDIO_CONTENT_API_KEY_SECRET_ID} has no SecretString value`,
        11
      );
    }
    return value;
  }
  // No credential configured at all — Atrium content access is not set up.
  fail(
    'No content API key configured. Set AISTUDIO_CONTENT_API_KEY (a scoped sk- ' +
      'key holding content: scopes) or AISTUDIO_CONTENT_API_KEY_SECRET_ID. See ' +
      'SKILL.md for the deployment prerequisites.',
    11
  );
  return ''; // unreachable
}

/**
 * The result of a REST call. `approvalRequired` marks the §26.4 structured 202
 * (queued-for-approval) — a SUCCESS-shaped outcome, NOT an error: the caller must
 * surface `payload.message` verbatim so the agent tells the user it is queued.
 */

/**
 * Single entry point for every Atrium content REST call. Handles auth (bearer sk-
 * content key), query serialization, the v1 `{ data, meta }` / `{ error }`
 * envelope, and uniform error surfacing.
 *
 *   - method: HTTP method ('GET' | 'POST' | 'PATCH' | 'DELETE')
 *   - path:   path under the content base (e.g. '', '/<id>', '/<id>/publish')
 *   - opts.query: object serialized to the query string (undefined values skipped)
 *   - opts.body:  object JSON-encoded as the request body
 *
 * Returns `{ approvalRequired, status, payload }` on 2xx/202. On 401 → exit 11,
 * 429 → exit 14, any other non-2xx → structured error on stdout + exit 12. Checks
 * `resp.ok` BEFORE trusting a JSON body so an infra 502/503 is never mistaken for
 * an app response (CLAUDE.md silent-failure pattern).
 */
async function restFetch(method, path, opts = {}) {
  const base = resolveContentBaseUrl();
  if (!base) {
    fail(
      'AI Studio content API URL is not configured. Set AISTUDIO_CONTENT_API_URL ' +
        'or APP_BASE_URL.',
      1
    );
  }

  const apiKey = await resolveApiKey();

  let url = base + path;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      fail(
        `AI Studio content API request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        12
      );
    }
    fail(`Network error calling AI Studio content API: ${err.message}`, 12);
  }

  // Read the body ONCE as text, then try to parse it as JSON. Keeping the raw text
  // lets the error branches surface a NON-JSON infra body (an ALB/nginx 502/503
  // HTML page) verbatim, instead of the useless "{}" a consumed `.json()` gives.
  const rawText = await resp.text().catch(() => '');
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null; // non-JSON body (e.g. an infra proxy error page)
    }
  }

  if (resp.status === 401) {
    emit({
      status: 'unauthorized',
      message:
        'AI Studio rejected the content API key (401). The key must be a valid ' +
        'sk- key holding the content: scopes for this operation.',
      detail: rawText.slice(0, 512),
    });
    process.exit(11);
  }
  if (resp.status === 429) {
    emit({
      status: 'rate-limited',
      message: 'AI Studio is rate-limiting this key. Wait and retry.',
    });
    process.exit(14);
  }

  // §26.4: a public publish/unpublish/widen the caller may not perform directly
  // comes back as HTTP 202 with { data: { status: 'approval_required', message } }.
  // This is NOT an error — it is queued for a human/admin to approve.
  if (resp.status === 202) {
    const payload = data && data.data !== undefined ? data.data : data;
    return { approvalRequired: true, status: 202, payload };
  }

  if (!resp.ok) {
    // Error envelope is { error: { code, message, details? }, requestId }. Surface
    // it verbatim (exit 12); a non-JSON body (infra 502/503) has no envelope, so
    // fall back to the RAW text for debug context rather than an empty "{}".
    const err = data && data.error ? data.error : null;
    emit({
      status: 'error',
      http_status: resp.status,
      code: err ? err.code : undefined,
      message: err
        ? err.message
        : `AI Studio content API returned HTTP ${resp.status}`,
      detail: err ? undefined : rawText.slice(0, 512),
    });
    process.exit(12);
  }

  if (!data) fail(`AI Studio content API returned a non-JSON body`, 12);

  const payload = data.data !== undefined ? data.data : data;
  return { approvalRequired: false, status: resp.status, payload };
}

/**
 * Parse a comma-separated `--tags a,b,c` flag into a string[] (trimmed,
 * empties dropped). Returns undefined when the flag was absent. A value-LESS
 * flag (`--tags` with nothing after it — parseArgs yields `true`) is a usage
 * error, NOT a silent no-op, so a typo can't drop the field unnoticed.
 */
function parseList(value, label = 'tags') {
  if (value === undefined) return undefined;
  if (value === true) fail(`--${label} requires a value`);
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Parse `--grants kind:value,kind:value` into the group-grant shape
 * [{ kind, value }]. Throws (via fail) on a value-less flag or a malformed entry
 * so a typo is a clear usage error, not a silently dropped grant.
 */
function parseGrants(value, label = 'grants') {
  if (value === undefined) return undefined;
  if (value === true) fail(`--${label} requires a value`);
  const VALID = ['role', 'building', 'department', 'grade', 'user'];
  const grants = [];
  for (const raw of String(value).split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const idx = entry.indexOf(':');
    if (idx <= 0) fail(`--grants entry must be kind:value, got "${entry}"`);
    const kind = entry.slice(0, idx).trim();
    const val = entry.slice(idx + 1).trim();
    if (!VALID.includes(kind)) {
      fail(`--grants kind must be one of ${VALID.join('|')}, got "${kind}"`);
    }
    if (!val) fail(`--grants entry "${entry}" has an empty value`);
    grants.push({ kind, value: val });
  }
  return grants.length ? grants : undefined;
}

module.exports = {
  fail,
  emit,
  parseArgs,
  parseList,
  parseGrants,
  resolveContentBaseUrl,
  resolveApiKey,
  restFetch,
  encodeContentBody,
  withEncodedBody,
};
