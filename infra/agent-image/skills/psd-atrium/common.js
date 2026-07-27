/** Owner-bound Atrium client. Authority comes from the signed agent invocation. */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');
const _internals = { requestAgentBroker };

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
 * The result of a REST call. `approvalRequired` marks the §26.4 structured 202
 * (queued-for-approval) — a SUCCESS-shaped outcome, NOT an error: the caller must
 * surface `payload.message` verbatim so the agent tells the user it is queued.
 */

/**
 * Single entry point for every Atrium content operation. The web tier resolves
 * the signed owner to a Content Requester and invokes the shared service layer;
 * no reusable content credential is exposed to the workspace.
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
  const query = {};
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') query[k] = String(v);
    }
  }

  let result;
  try {
    result = await _internals.requestAgentBroker(
      '/api/agent/atrium',
      {
        method,
        path,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      },
      { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 }
    );
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

  const status = Number(result.httpStatus);
  const data = result.payload;
  const rawText = String(result.rawText || '');

  if (status === 401) {
    emit({
      status: 'unauthorized',
      message:
        'AI Studio rejected the signed owner authority for this operation.',
      detail: rawText.slice(0, 512),
    });
    process.exit(11);
  }
  if (status === 429) {
    emit({
      status: 'rate-limited',
      message: 'AI Studio is rate-limiting this key. Wait and retry.',
    });
    process.exit(14);
  }

  // §26.4: a public publish/unpublish/widen the caller may not perform directly
  // comes back as HTTP 202 with { data: { status: 'approval_required', message } }.
  // This is NOT an error — it is queued for a human/admin to approve.
  if (status === 202) {
    const payload = data && data.data !== undefined ? data.data : data;
    return { approvalRequired: true, status: 202, payload };
  }

  if (status < 200 || status >= 300) {
    // Error envelope is { error: { code, message, details? }, requestId }. Surface
    // it verbatim (exit 12); a non-JSON body (infra 502/503) has no envelope, so
    // fall back to the RAW text for debug context rather than an empty "{}".
    const err = data && data.error ? data.error : null;
    emit({
      status: 'error',
      http_status: status,
      code: err ? err.code : undefined,
      message: err
        ? err.message
        : `AI Studio content API returned HTTP ${status}`,
      detail: err ? undefined : rawText.slice(0, 512),
    });
    process.exit(12);
  }

  if (!data) fail(`AI Studio content API returned a non-JSON body`, 12);

  const payload = data.data !== undefined ? data.data : data;
  return { approvalRequired: false, status, payload };
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
  return items.length > 0 ? items : undefined;
}

/**
 * Parse `--grants kind:value,kind:value` into the group-grant shape
 * [{ kind, value }]. Throws (via fail) on a value-less flag or a malformed entry
 * so a typo is a clear usage error, not a silently dropped grant.
 */
function parseGrants(value, label = 'grants') {
  if (value === undefined) return undefined;
  if (value === true) fail(`--${label} requires a value`);
  const VALID = ['role', 'building', 'department', 'grade', 'user', 'group'];
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
  return grants.length > 0 ? grants : undefined;
}

module.exports = {
  fail,
  emit,
  parseArgs,
  parseList,
  parseGrants,
  restFetch,
  encodeContentBody,
  withEncodedBody,
  _internals,
};
