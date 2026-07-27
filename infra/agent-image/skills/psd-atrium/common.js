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
        ...(Object.keys(query).length ? { query } : {}),
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
  return grants.length ? grants : undefined;
}

/**
 * The base64url SHA-256 digest the Atrium asset API expects (`sha256` on both
 * initiate and complete). NOT base64 — the server validates
 * /^[A-Za-z0-9_-]{43}$/ and re-derives the same digest from the uploaded bytes,
 * so a padded/standard-alphabet digest is rejected at initiate.
 */
function sha256Base64Url(bytes) {
  return require('node:crypto').createHash('sha256').update(bytes).digest('base64url');
}

/**
 * Identify an image by its MAGIC BYTES, not its filename. The asset API accepts
 * only PNG/JPEG/WebP and re-derives the true type server-side during
 * normalization, so trusting a `.png` suffix on JPEG bytes would reserve an
 * upload that then fails completion with an opaque rejection. Returns null for
 * anything else so the caller can refuse with a clear message.
 */
function detectImageContentType(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * PUT raw bytes at a presigned S3 URL. This is the ONE call in this skill that
 * does not go through the loopback broker: the reservation returns a
 * short-lived, pre-signed, checksum-pinned URL, and the agent runtime has
 * outbound HTTPS. Routing megabytes of image through the broker instead would
 * put them through a JSON envelope for no gain.
 *
 * The URL is never author-supplied — it comes straight back from the Atrium
 * initiate response — and only https is accepted, so this cannot be steered at
 * an internal endpoint by document content.
 */
async function putPresignedBytes(url, headers, bytes, timeoutMs = REQUEST_TIMEOUT_MS) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('asset upload URL returned by AI Studio is not a valid URL', 12);
  }
  if (parsed.protocol !== 'https:') {
    fail(`asset upload URL must be https, got ${parsed.protocol}`, 12);
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: 'PUT',
      headers,
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      fail(`asset upload timed out after ${timeoutMs}ms`, 12);
    }
    fail(`network error uploading asset bytes: ${err.message}`, 12);
  }
  if (!resp.ok) {
    // Read the body for context BEFORE deciding — S3 returns a descriptive XML
    // error (SignatureDoesNotMatch, EntityTooLarge, …) that is the only clue.
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 512);
    } catch {
      /* body already consumed / not readable */
    }
    emit({
      status: 'error',
      http_status: resp.status,
      message: `asset upload storage rejected the PUT (HTTP ${resp.status})`,
      detail,
    });
    process.exit(12);
  }
}

_internals.putPresignedBytes = putPresignedBytes;

module.exports = {
  fail,
  emit,
  parseArgs,
  parseList,
  parseGrants,
  restFetch,
  encodeContentBody,
  withEncodedBody,
  sha256Base64Url,
  detectImageContentType,
  putPresignedBytes,
  _internals,
};
