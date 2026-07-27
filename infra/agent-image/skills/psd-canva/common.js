/** Owner-bound Canva client. OAuth credentials stay in the trusted web tier. */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');
const _internals = { requestAgentBroker };

const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;
const CANVA_API_BASE = 'https://api.canva.com/rest';
const CANVA_OAUTH_TOKEN_URL =
  'https://api.canva.com/rest/v1/oauth/token';

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

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
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
 * The legacy --user value is retained only for user-facing consent wording.
 * It is never sent to a privileged service; the broker derives the owner from
 * the router-signed invocation context.
 */
function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  if (typeof email !== 'string' || !SAFE_EMAIL_RE.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}

async function authorizeUser(ownerEmail) {
  void ownerEmail;
  let status;
  try {
    status = await _internals.requestAgentBroker('/api/agent/canva', {
      operation: 'status',
    });
  } catch (err) {
    fail(`Unable to check Canva authorization: ${err.message}`, 12);
  }
  if (!status.connected) {
    await emitNeedsAuthAndExit(
      ownerEmail,
      'no Canva token stored for this signed owner yet'
    );
  }
  // Opaque compatibility sentinel. No access token crosses the broker boundary.
  return 'owner-bound-canva-broker';
}

async function mintConsentUrl(ownerEmail) {
  void ownerEmail;
  const result = await _internals.requestAgentBroker('/api/agent/consent-link', {
    kind: 'canva',
  });
  if (!result || typeof result.url !== 'string') {
    throw new Error('Consent-link broker returned no URL');
  }
  return result.url;
}

async function emitNeedsAuthAndExit(ownerEmail, reason) {
  let consentUrl;
  try {
    consentUrl = await mintConsentUrl(ownerEmail);
  } catch (err) {
    fail(`Unable to mint consent URL: ${err.message}`);
  }
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

function canvaRequestPayload(method, path, opts) {
  const query = {};
  for (const [key, value] of Object.entries(opts.query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      query[key] = String(value);
    }
  }
  return {
    operation: 'request',
    method,
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.rawBody !== undefined
      ? {
          rawBodyBase64: Buffer.from(opts.rawBody).toString('base64'),
          uploadMetadata:
            opts.headers && opts.headers['Asset-Upload-Metadata'],
        }
      : {}),
  };
}

function unauthorizedError(message) {
  return Object.assign(new Error(message), {
    code: 'unauthorized',
    status: 401,
  });
}

function rateLimitError() {
  return Object.assign(new Error('Canva API rate limited (HTTP 429)'), {
    code: 'rate_limited',
    status: 429,
  });
}

function canvaHttpError(result, status) {
  const upstream =
    result.payload && typeof result.payload === 'object'
      ? result.payload
      : {};
  return Object.assign(
    new Error(
      upstream.message || `Canva API error: HTTP ${status || 'unknown'}`
    ),
    {
      code: upstream.code || `http_${status || 'unknown'}`,
      status,
    }
  );
}

function canvaRetryDelay(result, attempt) {
  const seconds = Number(result.retryAfter);
  return Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : 1000 * Math.pow(2, attempt);
}

async function parseCanvaResponse(result, attempt, maxRetries) {
  const status = Number(result.httpStatus);
  if (status === 429) {
    const error = rateLimitError();
    if (attempt < maxRetries - 1) {
      await sleep(canvaRetryDelay(result, attempt));
    }
    return { retry: true, error };
  }
  if (status === 401) {
    throw unauthorizedError('Canva rejected the owner-bound authorization');
  }
  if (status < 200 || status >= 300) {
    throw canvaHttpError(result, status);
  }
  return {
    retry: false,
    payload: status === 204 ? null : (result.payload ?? null),
  };
}

async function canvaFetch(accessToken, method, path, opts = {}) {
  void accessToken;
  const payload = canvaRequestPayload(method, path, opts);
  const maxRetries = 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let result;
    try {
      result = await _internals.requestAgentBroker(
        '/api/agent/canva',
        payload,
        { timeoutMs: 35_000 }
      );
    } catch (err) {
      if (err && err.status === 401) {
        throw unauthorizedError('Canva authorization is missing or expired');
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries - 1) throw lastError;
      continue;
    }
    const parsed = await parseCanvaResponse(result, attempt, maxRetries);
    if (!parsed.retry) return parsed.payload;
    lastError = parsed.error;
  }
  throw lastError || new Error('Canva API request failed after retries');
}

async function pollJob(accessToken, pollPathPrefix, jobId) {
  const deadline = Date.now() + 90_000;
  let interval = 2000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await canvaFetch(
      accessToken,
      'GET',
      `${pollPathPrefix}/${encodeURIComponent(jobId)}`
    );
    const job = poll && poll.job;
    if (job && job.status === 'success') return job;
    if (job && job.status === 'failed') {
      throw Object.assign(
        new Error(
          `Canva job ${jobId} failed: ${
            job.error ? JSON.stringify(job.error) : 'unknown error'
          }`
        ),
        { code: 'job_failed', status: 500 }
      );
    }
    interval = Math.min(interval * 1.5, 8000);
  }
  throw Object.assign(
    new Error(`Canva job ${jobId} timed out`),
    { code: 'job_timeout', status: 408 }
  );
}

async function startAndPollJob(accessToken, startPath, pollPathPrefix, body) {
  const start = await canvaFetch(accessToken, 'POST', startPath, { body });
  const job = start && start.job;
  if (!job || !job.id) {
    throw Object.assign(
      new Error('Canva job response missing job.id'),
      { code: 'bad_job', status: 502 }
    );
  }
  if (job.status === 'success') return job;
  return pollJob(accessToken, pollPathPrefix, job.id);
}

function failFromCanvaError(err, tool) {
  if (err && err.code === 'rate_limited') {
    emit({
      status: 'rate-limited',
      tool,
      message: 'Canva is rate-limiting requests. Wait a moment and retry.',
    });
    process.exit(14);
  }
  emit({
    status: 'canva-error',
    tool,
    code: err && err.code,
    http_status: err && err.status,
    message: err && err.message,
  });
  process.exit(12);
}

module.exports = {
  fail,
  emit,
  sleep,
  parseArgs,
  validateUserEmail,
  authorizeUser,
  mintConsentUrl,
  emitNeedsAuthAndExit,
  canvaFetch,
  pollJob,
  startAndPollJob,
  failFromCanvaError,
  CANVA_API_BASE,
  CANVA_OAUTH_TOKEN_URL,
  _internals,
};
