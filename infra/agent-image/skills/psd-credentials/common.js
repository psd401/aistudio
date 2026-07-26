/**
 * Shared helpers for the owner-bound credential broker.
 *
 * The model-facing runtime has no Secrets Manager or database credentials.
 * Every operation is sent to the trusted web tier with the opaque, short-lived
 * invocation context issued by the router or scheduler. The web tier verifies
 * that context and derives the owner; no CLI argument can select an identity.
 */

'use strict';

const {
  agentRequestHeaders,
} = require('../_shared/invocation-context');

const SAFE_CRED_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const AUTHORITY_ARGS = ['user', 'owner_email', 'user_email', 'user_id'];

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

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
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function rejectAuthorityArgs(args) {
  const supplied = AUTHORITY_ARGS.find((name) =>
    Object.prototype.hasOwnProperty.call(args, name));
  if (supplied) {
    fail(`--${supplied.replace(/_/g, '-')} is not accepted; identity comes from the signed invocation`);
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function validateCredentialName(name) {
  if (typeof name !== 'string' || !SAFE_CRED_NAME_RE.test(name)) {
    fail(`Invalid credential name: "${name}". Only 1-128 alphanumeric, dot, hyphen, or underscore characters are allowed.`);
  }
}

function brokerUrl() {
  const raw = process.env.APP_BASE_URL;
  if (!raw) {
    throw new Error('APP_BASE_URL is not configured');
  }
  let base;
  try {
    base = new URL(raw);
  } catch {
    throw new Error('APP_BASE_URL is invalid');
  }
  const localHttp =
    base.protocol === 'http:' &&
    (base.hostname === 'localhost' || base.hostname === '127.0.0.1');
  if (base.protocol !== 'https:' && !localHttp) {
    throw new Error('APP_BASE_URL must use HTTPS');
  }
  base.pathname = '/api/agent/credentials';
  base.search = '';
  base.hash = '';
  return base;
}

async function requestCredentialOperation(payload) {
  const response = await fetch(brokerUrl(), {
    method: 'POST',
    headers: agentRequestHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Credential broker returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const reason =
      body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    const error = new Error(`Credential broker rejected the request: ${reason}`);
    error.status = response.status;
    error.responseBody = body;
    throw error;
  }
  return body;
}

module.exports = {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  validateCredentialName,
  requestCredentialOperation,
};
