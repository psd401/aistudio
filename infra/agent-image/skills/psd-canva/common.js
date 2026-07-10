/**
 * Shared helpers for the psd-canva OpenClaw skill.
 *
 * Acts on the caller's OWN Canva account via Canva's Connect REST API
 * (https://api.canva.com/rest), authenticated per-user with an OAuth refresh
 * token (single-use, rotates on each exchange). Each caller only ever touches
 * their own Canva account — the per-user token is stored in Secrets Manager by
 * email; there is no shared Canva account.
 *
 * Canva is a CONFIDENTIAL OAuth client: the shared client_id + client_secret
 * live in psd-agent/{env}/canva-oauth-client and are used ONLY in the HTTP
 * Basic auth header of the token endpoint. The one-time browser consent is
 * driven by AI Studio's /agent-connect-canva flow; this skill only does
 * headless refresh and writes the rotated refresh token back immediately.
 *
 * Environment contract (set by infra/lib/agent-platform-stack.ts / defaults):
 *   AWS_REGION                          — e.g. us-east-1
 *   ENVIRONMENT                         — dev/staging/prod
 *   APP_BASE_URL                        — Base URL of the AI Studio web app
 *   AGENT_INTERNAL_API_KEY_SECRET_ID    — Secrets Manager ID for shared secret
 *   CANVA_API_BASE                      — REST base (default https://api.canva.com/rest)
 *   CANVA_OAUTH_TOKEN_URL               — token endpoint (default …/rest/v1/oauth/token)
 *   CANVA_OAUTH_SECRET_ID               — SM id holding {client_id, client_secret}
 */

'use strict';

// Reuse psd-workspace's already-installed AWS SDK copy (keeps image file-count
// flat — same rationale as psd-plaud/psd-data). This skill ships no
// node_modules. Falls back to a bare require so the skill is loadable/testable
// outside the container (e.g. from the repo tree) as well.
function requireSecretsManager() {
  try {
    return require('/opt/psd-skills/psd-workspace/node_modules/@aws-sdk/client-secrets-manager');
  } catch {
    return require('@aws-sdk/client-secrets-manager');
  }
}
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = requireSecretsManager();

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const AGENT_INTERNAL_API_KEY_SECRET_ID =
  process.env.AGENT_INTERNAL_API_KEY_SECRET_ID ||
  `psd-agent/${ENVIRONMENT}/internal-api-key`;
const CANVA_API_BASE = (process.env.CANVA_API_BASE || 'https://api.canva.com/rest').replace(/\/$/, '');
const CANVA_OAUTH_TOKEN_URL =
  process.env.CANVA_OAUTH_TOKEN_URL || 'https://api.canva.com/rest/v1/oauth/token';
const CANVA_OAUTH_SECRET_ID =
  process.env.CANVA_OAUTH_SECRET_ID || `psd-agent/${ENVIRONMENT}/canva-oauth-client`;

const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;

const smClient = new SecretsManagerClient({ region: REGION });

function fail(message, code = 1) {
  process.stderr.write(`psd-canva: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// argv parser — identical convention to psd-plaud: a positional subcommand
// (`whoami`, `list-designs`, …) is COLLECTED into args._ rather than rejected.
// Flag VALUES are consumed via the i++ below, so args._[0] is always the real
// subcommand — not a flag's value.
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

function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  if (typeof email !== 'string' || !SAFE_EMAIL_RE.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}

// Per-user Canva token slot. Same convention as the Google/Plaud slots;
// covered by the existing psd-agent-creds/{env}/* IAM grants (no new IAM).
function canvaTokenSecretId(email) {
  return `psd-agent-creds/${ENVIRONMENT}/user/${email}/canva`;
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
 * Per-user Canva token record, written by the /agent-connect-canva callback.
 * Shape: { refresh_token, obtained_at, scope? }. Returns null when the user
 * hasn't completed consent yet.
 */
async function getUserCanvaRecord(email) {
  try { return await getSecretJson(canvaTokenSecretId(email)); }
  catch (err) {
    if (err && err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

/**
 * The shared confidential client credentials {client_id, client_secret}.
 * Returns null when the secret is empty or still a placeholder.
 */
async function getCanvaClientCreds() {
  try {
    const creds = await getSecretJson(CANVA_OAUTH_SECRET_ID);
    const id = creds && creds.client_id;
    const secret = creds && creds.client_secret;
    if (id && secret && id !== 'PLACEHOLDER' && secret !== 'PLACEHOLDER') {
      return { client_id: id, client_secret: secret };
    }
    return null;
  } catch { return null; }
}

/**
 * Persist a rotated refresh token back to the user's secret. Canva rotates the
 * refresh token on EVERY exchange and reusing an old one revokes the whole
 * grant — so writing the new one back immediately is mandatory, not optional.
 * The AgentCore role holds PutSecretValue on psd-agent-creds/{env}/user/*.
 */
async function updateStoredRefreshToken(email, record, newRefreshToken) {
  if (!newRefreshToken || newRefreshToken === record.refresh_token) return;
  const next = { ...record, refresh_token: newRefreshToken, obtained_at: new Date().toISOString() };
  await smClient.send(new PutSecretValueCommand({
    SecretId: canvaTokenSecretId(email),
    SecretString: JSON.stringify(next),
  }));
}

/**
 * Exchange the stored refresh token for a fresh access token at Canva's token
 * endpoint. CONFIDENTIAL client → HTTP Basic auth (client_id:client_secret) +
 * refresh_token grant, form-encoded. Throws with code 'invalid_grant' when the
 * refresh token is revoked/expired.
 */
async function refreshCanvaAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const resp = await fetch(CANVA_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Canva token refresh failed: ${resp.status} ${data.error || ''}`);
    err.code = data.error || `http_${resp.status}`;
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null, // Canva always rotates
    expires_in: data.expires_in || null,
  };
}

/**
 * Resolve a usable access token for the caller: read the per-user record
 * (needs-auth if none), read the shared client creds, refresh, and write the
 * rotated refresh token back BEFORE any API call. Emits needs-auth (exit 10)
 * when unauthorized. Returns the bearer access token string.
 */
async function authorizeUser(ownerEmail) {
  const record = await getUserCanvaRecord(ownerEmail);
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit(ownerEmail, 'no Canva token stored for this user yet');
  }
  const creds = await getCanvaClientCreds();
  if (!creds) fail('Canva OAuth client is not configured (CANVA_OAUTH_SECRET_ID)', 12);

  let auth;
  try {
    auth = await refreshCanvaAccessToken(record.refresh_token, creds.client_id, creds.client_secret);
  } catch (err) {
    if (err.code === 'invalid_grant' || err.code === 'invalid_request' || err.code === 'unauthorized_client') {
      await emitNeedsAuthAndExit(ownerEmail, `stored Canva token rejected: ${err.code}`);
    }
    fail(`Canva token refresh failed: ${err.message}`, 12);
  }
  // Mandatory write-back of the rotated refresh token (Canva single-use grant).
  await updateStoredRefreshToken(ownerEmail, record, auth.refresh_token);
  return auth.access_token;
}

/** Mint a one-time consent URL (chat → browser) via AI Studio. */
async function mintConsentUrl(ownerEmail) {
  if (!APP_BASE_URL) throw new Error('APP_BASE_URL env var not set — cannot mint consent URL');
  const apiKey = await getSecretString(AGENT_INTERNAL_API_KEY_SECRET_ID);
  if (!apiKey) throw new Error(`Internal API key secret ${AGENT_INTERNAL_API_KEY_SECRET_ID} is empty`);
  const resp = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}/api/agent/consent-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ownerEmail, kind: 'canva' }),
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
    kind: 'canva',
    reason,
    consent_url: consentUrl,
    consent_chat_hyperlink: `<${consentUrl}|Connect your Canva account>`,
    message:
      'Paste consent_chat_hyperlink on its own line, no surrounding markdown. ' +
      'Then on a separate line: "Click the link to connect your Canva account so I can create and export designs for you."',
  });
  process.exit(10);
}

/**
 * Core authenticated Canva REST request with 429/Retry-After backoff (ported
 * from lib/mcp/custom-tools/canva/canva-api-client.ts, review-hardened in
 * PR #1144). `query` are appended as search params; `body` is JSON-encoded
 * unless `rawBody` (a Buffer/Uint8Array) is provided for binary uploads.
 * Throws a typed error ({code,status}) — 401 → 'unauthorized', all-429 →
 * 'rate_limited' — so callers can map to needs-auth / rate-limited exits.
 */
async function canvaFetch(accessToken, method, path, opts = {}) {
  const { query, body, rawBody, headers } = opts;
  const url = new URL(`${CANVA_API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const MAX_RETRIES = 3;
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const h = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(headers || {}) };
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let resp;
    try {
      resp = await fetch(url.toString(), { method, headers: h, body: payload, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === MAX_RETRIES - 1) throw lastError;
      continue;
    }

    if (resp.status === 429) {
      lastError = Object.assign(new Error('Canva API rate limited (HTTP 429)'), { code: 'rate_limited', status: 429 });
      const retryAfter = resp.headers.get('Retry-After');
      let waitMs = 1000 * Math.pow(2, attempt);
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) waitMs = seconds * 1000;
        else { const dateMs = Date.parse(retryAfter); if (!Number.isNaN(dateMs)) waitMs = Math.max(0, dateMs - Date.now()); }
      }
      if (attempt < MAX_RETRIES - 1) await sleep(waitMs);
      continue;
    }

    if (resp.status === 401) {
      throw Object.assign(new Error('Canva rejected the access token (401)'), { code: 'unauthorized', status: 401 });
    }

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw Object.assign(
        new Error(errBody.message || `Canva API error: HTTP ${resp.status}`),
        { code: errBody.code || `http_${resp.status}`, status: resp.status }
      );
    }

    if (resp.status === 204) return null;
    return await resp.json().catch(() => null);
  }
  throw lastError || new Error('Canva API request failed after retries');
}

/** Poll a Canva async job (export/upload) to completion. */
async function pollJob(accessToken, pollPathPrefix, jobId) {
  const deadline = Date.now() + 90_000;
  let interval = 2000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await canvaFetch(accessToken, 'GET', `${pollPathPrefix}/${encodeURIComponent(jobId)}`);
    const job = poll && poll.job;
    if (job && job.status === 'success') return job;
    if (job && job.status === 'failed') {
      throw Object.assign(
        new Error(`Canva job ${jobId} failed: ${job.error ? JSON.stringify(job.error) : 'unknown error'}`),
        { code: 'job_failed', status: 500 }
      );
    }
    interval = Math.min(interval * 1.5, 8000);
  }
  throw Object.assign(new Error(`Canva job ${jobId} timed out`), { code: 'job_timeout', status: 408 });
}

/** Start a JSON-body async job (POST) and poll the same path to completion. */
async function startAndPollJob(accessToken, startPath, pollPathPrefix, body) {
  const start = await canvaFetch(accessToken, 'POST', startPath, { body });
  const job = start && start.job;
  if (!job || !job.id) {
    throw Object.assign(new Error('Canva job response missing job.id'), { code: 'bad_job', status: 502 });
  }
  if (job.status === 'success') return job;
  return pollJob(accessToken, pollPathPrefix, job.id);
}

/**
 * Map a thrown Canva error to a structured stdout payload + exit code, so the
 * model gets a clean, non-improvisable failure instead of a stack trace.
 * needs-auth is handled by the caller (it needs ownerEmail to mint a link).
 */
function failFromCanvaError(err, tool) {
  if (err && err.code === 'rate_limited') {
    emit({ status: 'rate-limited', tool, message: 'Canva is rate-limiting requests. Wait a moment and retry.' });
    process.exit(14);
  }
  emit({ status: 'canva-error', tool, code: err && err.code, http_status: err && err.status, message: err && err.message });
  process.exit(12);
}

module.exports = {
  fail, emit, sleep, parseArgs, validateUserEmail,
  canvaTokenSecretId, getUserCanvaRecord, getCanvaClientCreds,
  refreshCanvaAccessToken, updateStoredRefreshToken, authorizeUser,
  mintConsentUrl, emitNeedsAuthAndExit,
  canvaFetch, pollJob, startAndPollJob, failFromCanvaError,
  CANVA_API_BASE, CANVA_OAUTH_TOKEN_URL,
};
