/**
 * Shared helpers for the psd-workspace OpenClaw skill (#912).
 *
 * Environment contract (set in agent-platform-stack.ts):
 *   AWS_REGION                         — e.g. us-east-1
 *   ENVIRONMENT                        — dev/staging/prod
 *   GOOGLE_OAUTH_CLIENT_SECRET_ID      — Secrets Manager ID for OAuth client creds
 *   AGENT_INTERNAL_API_KEY_SECRET_ID   — Secrets Manager ID for internal API key
 *   APP_BASE_URL                       — Base URL of the Next.js app (consent-link host)
 */

'use strict';

const { spawnSync } = require('node:child_process');

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const GOOGLE_OAUTH_CLIENT_SECRET_ID = process.env.GOOGLE_OAUTH_CLIENT_SECRET_ID
  || `psd-agent/${ENVIRONMENT}/google-oauth-client`;
const AGENT_INTERNAL_API_KEY_SECRET_ID = process.env.AGENT_INTERNAL_API_KEY_SECRET_ID
  || `psd-agent/${ENVIRONMENT}/internal-api-key`;

const WORKSPACE_SECRET_PATH = (email) =>
  `psd-agent-creds/${ENVIRONMENT}/user/${email}/google-workspace`;

const smClient = new SecretsManagerClient({ region: REGION });

// Strict email regex — must stay in sync with lib/agent-workspace/validation.ts.
// The email is interpolated into a Secrets Manager path, so we reject anything
// beyond alphanumeric + common email chars to prevent path manipulation.
const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;

function fail(message, code = 1) {
  process.stderr.write(`psd-workspace: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
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

function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  if (!SAFE_EMAIL_RE.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}

async function getSecretJson(secretId) {
  const resp = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!resp.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  try {
    return JSON.parse(resp.SecretString);
  } catch (err) {
    throw new Error(`Secret ${secretId} is not valid JSON: ${err.message}`);
  }
}

async function getSecretString(secretId) {
  const resp = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!resp.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  return resp.SecretString;
}

/**
 * Fetch the per-user workspace refresh-token record from Secrets Manager.
 * Returns null if not provisioned yet.
 * Record shape: { refresh_token, granted_scopes, obtained_at }
 */
async function getUserWorkspaceToken(userEmail) {
  try {
    return await getSecretJson(WORKSPACE_SECRET_PATH(userEmail));
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

/**
 * Exchange a refresh token for an access token via Google's OAuth2 endpoint.
 * Throws with code='invalid_grant' on revocation so callers can mark stale.
 */
async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Google token exchange failed: ${resp.status} ${data.error || ''}`);
    err.code = data.error || `http_${resp.status}`;
    throw err;
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    scope: data.scope,
  };
}

/**
 * Ask the Next.js app for a fresh, signed consent URL for the given owner.
 */
async function mintConsentUrl(ownerEmail) {
  if (!APP_BASE_URL) {
    throw new Error('APP_BASE_URL env var not set — cannot mint consent URL');
  }
  const apiKey = await getSecretString(AGENT_INTERNAL_API_KEY_SECRET_ID);
  const resp = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}/api/agent/consent-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ownerEmail }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.url) {
    throw new Error(`Consent-link API failed: ${resp.status} ${data.error || ''}`);
  }
  return data.url;
}

/**
 * Parse --command into argv-style tokens. Supports single-quoted segments so
 * users can pass flags like `--query 'is:unread'`. Not a full shell parser.
 */
function splitCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return [];
  const tokens = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/**
 * Exec gws with GOOGLE_ACCESS_TOKEN set. Streams stdout; returns exit code.
 */
function execGws(commandString, accessToken) {
  const tokens = splitCommand(commandString);
  if (tokens.length === 0) {
    fail('--command is empty');
  }
  const result = spawnSync('gws', tokens, {
    env: { ...process.env, GOOGLE_ACCESS_TOKEN: accessToken },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    fail(`Failed to exec gws: ${result.error.message}`, 2);
  }
  return result.status == null ? 1 : result.status;
}

module.exports = {
  REGION,
  ENVIRONMENT,
  APP_BASE_URL,
  GOOGLE_OAUTH_CLIENT_SECRET_ID,
  AGENT_INTERNAL_API_KEY_SECRET_ID,
  WORKSPACE_SECRET_PATH,
  fail,
  emit,
  parseArgs,
  validateUserEmail,
  getSecretJson,
  getSecretString,
  getUserWorkspaceToken,
  refreshAccessToken,
  mintConsentUrl,
  splitCommand,
  execGws,
};
