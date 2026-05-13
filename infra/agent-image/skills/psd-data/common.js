/**
 * Shared helpers for the psd-data OpenClaw skill.
 *
 * Authenticates the caller against the PSD data MCP server using a Cognito
 * id_token derived from the user's stored refresh token. On missing or
 * expired refresh token, mints a consent URL via AI Studio's
 * /api/agent/consent-link endpoint (kind: cognito_data) so the agent can
 * post the link in chat and have the user authorize.
 *
 * Environment contract (set by infra/lib/agent-platform-stack.ts):
 *   AWS_REGION                          — e.g. us-east-1 (Cognito region)
 *   ENVIRONMENT                         — dev/staging/prod
 *   APP_BASE_URL                        — Base URL of the AI Studio web app
 *   AGENT_INTERNAL_API_KEY_SECRET_ID    — Secrets Manager ID for shared secret
 *   AUTH_COGNITO_USER_POOL_ID           — Cognito user pool (info only)
 *   AUTH_COGNITO_CLIENT_ID              — Cognito app client (used for refresh)
 *   AUTH_COGNITO_REGION                 — Cognito region (defaults to AWS_REGION)
 *   PSD_DATA_MCP_URL                    — MCP server JSON-RPC endpoint
 */

'use strict';

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const AGENT_INTERNAL_API_KEY_SECRET_ID =
  process.env.AGENT_INTERNAL_API_KEY_SECRET_ID ||
  `psd-agent/${ENVIRONMENT}/internal-api-key`;
const COGNITO_REGION =
  process.env.AUTH_COGNITO_REGION || REGION;
const COGNITO_CLIENT_ID = process.env.AUTH_COGNITO_CLIENT_ID || '';
const PSD_DATA_MCP_URL = process.env.PSD_DATA_MCP_URL || '';

const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;

const smClient = new SecretsManagerClient({ region: REGION });

function fail(message, code = 1) {
  process.stderr.write(`psd-data: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Minimal long-form argv parser. Same conventions as psd-workspace's
 * parseArgs — `--foo bar` and `--foo` (boolean) both supported, dashes in
 * key names become underscores so callers can use `args.user_email` etc.
 */
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
    if (next === undefined || next.startsWith('--')) {
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
  if (typeof email !== 'string' || !SAFE_EMAIL_RE.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}

function cognitoRefreshSecretId(email) {
  return `psd-agent-creds/${ENVIRONMENT}/user/${email}/cognito-refresh`;
}

async function getSecretJson(secretId) {
  const resp = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
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
  const resp = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  return resp.SecretString || null;
}

/**
 * Read the user's stored Cognito refresh-token record. Returns null when
 * the secret does not yet exist (user hasn't completed the consent flow).
 *
 * Record shape (written by `lib/auth/agent-token-sync.ts`):
 *   { refresh_token, obtained_at, user_pool_id, client_id, region }
 */
async function getUserCognitoRefreshRecord(email) {
  const secretId = cognitoRefreshSecretId(email);
  try {
    return await getSecretJson(secretId);
  } catch (err) {
    if (err && err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

/**
 * Exchange the user's Cognito refresh token for a fresh id_token by POSTing
 * directly to the Cognito Identity Provider service endpoint. No AWS
 * credentials required — InitiateAuth with REFRESH_TOKEN_AUTH is a public
 * endpoint that authenticates with the refresh token itself.
 *
 * Returns { id_token, access_token, expires_in } on success.
 * Throws an Error with `code === 'NotAuthorizedException'` when the
 * refresh token has been revoked or expired (caller should mint a fresh
 * consent URL).
 */
async function refreshCognitoIdToken(refreshToken, clientId, region) {
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
  const body = JSON.stringify({
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(
      `Cognito InitiateAuth failed: ${resp.status} ${data.__type || data.message || ''}`
    );
    // Cognito returns errors as { __type: "NotAuthorizedException", message: "..." }
    err.code = data.__type || `http_${resp.status}`;
    err.cognito = data;
    throw err;
  }

  const result = data.AuthenticationResult || {};
  if (!result.IdToken) {
    throw new Error('Cognito InitiateAuth returned no IdToken');
  }
  return {
    id_token: result.IdToken,
    access_token: result.AccessToken || null,
    expires_in: result.ExpiresIn || null,
  };
}

/**
 * Ask AI Studio for a fresh signed consent URL the agent can give the user
 * in chat. Uses the same internal-API-key auth as psd-workspace.
 */
async function mintConsentUrl(ownerEmail) {
  if (!APP_BASE_URL) {
    throw new Error('APP_BASE_URL env var not set — cannot mint consent URL');
  }
  const apiKey = await getSecretString(AGENT_INTERNAL_API_KEY_SECRET_ID);
  if (!apiKey) {
    throw new Error(
      `Internal API key secret ${AGENT_INTERNAL_API_KEY_SECRET_ID} is empty`
    );
  }
  const resp = await fetch(
    `${APP_BASE_URL.replace(/\/$/, '')}/api/agent/consent-link`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ownerEmail, kind: 'cognito_data' }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.url) {
    throw new Error(
      `Consent-link API failed: ${resp.status} ${data.error || ''}`
    );
  }
  return data.url;
}

/**
 * Emit a needs-auth payload and exit 10. Encapsulates the chat-format
 * conventions (psd-rules rule 9) so callers don't have to duplicate them.
 */
async function emitNeedsAuthAndExit(ownerEmail, reason) {
  let consentUrl;
  try {
    consentUrl = await mintConsentUrl(ownerEmail);
  } catch (err) {
    fail(`Unable to mint consent URL: ${err.message}`);
  }
  emit({
    status: 'needs-auth',
    kind: 'cognito_data',
    reason,
    consent_url: consentUrl,
    consent_chat_hyperlink: `<${consentUrl}|Authorize PSD data access>`,
    message:
      'Paste consent_chat_hyperlink on its own line, no surrounding markdown. ' +
      'Then on a separate line: "Click the link to let me query the PSD data warehouse on your behalf."',
  });
  process.exit(10);
}

/**
 * Single entry point for every MCP call. Handles auth (refresh-or-mint),
 * the JSON-RPC envelope, and uniform error surfacing.
 *
 *   - method: MCP method name ('tools/call', 'tools/list', etc.)
 *   - params: object — the JSON-RPC params field
 *   - ownerEmail: caller identity (used for the SM secret lookup)
 *
 * Side effects: writes the JSON-RPC result to stdout on success; emits a
 * needs-auth payload + exits 10 if no token; emits a structured error and
 * exits non-zero otherwise. Callers do not need to handle errors.
 */
async function callMcp(method, params, ownerEmail) {
  if (!PSD_DATA_MCP_URL) {
    fail('PSD_DATA_MCP_URL is not set');
  }
  if (!COGNITO_CLIENT_ID) {
    fail('AUTH_COGNITO_CLIENT_ID is not set');
  }

  const record = await getUserCognitoRefreshRecord(ownerEmail);
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit(
      ownerEmail,
      'no refresh token stored for this user yet'
    );
  }

  // Prefer the client_id captured at consent time; fall back to env var.
  const clientId = record.client_id || COGNITO_CLIENT_ID;
  const region = record.region || COGNITO_REGION;

  let auth;
  try {
    auth = await refreshCognitoIdToken(record.refresh_token, clientId, region);
  } catch (err) {
    if (
      err.code === 'NotAuthorizedException' ||
      err.code === 'invalid_grant' ||
      err.code === 'UserNotFoundException'
    ) {
      await emitNeedsAuthAndExit(
        ownerEmail,
        `stored refresh token rejected: ${err.code}`
      );
    }
    fail(`Cognito token refresh failed: ${err.message}`);
  }

  const requestId = Math.floor(Math.random() * 1e9);
  const rpcBody = {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params: params || {},
  };

  const resp = await fetch(PSD_DATA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.id_token}`,
      'X-Client-Model': process.env.BUILD_MARKER || 'agentcore',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify(rpcBody),
  });

  // psd-data-mcp uses HTTP status codes for auth/permission errors and the
  // JSON-RPC error field for tool errors. Handle both.
  if (resp.status === 401) {
    await emitNeedsAuthAndExit(ownerEmail, 'MCP server rejected token (401)');
  }
  if (resp.status === 403) {
    const text = await resp.text().catch(() => '');
    emit({
      status: 'forbidden',
      kind: 'data-permission',
      message:
        'The data MCP server denied access. Most likely the user is not yet ' +
        'registered in the PSD data warehouse userpermissions table. Contact ' +
        'the data team to be added.',
      detail: text.slice(0, 1024),
    });
    process.exit(13);
  }
  if (resp.status === 429) {
    emit({
      status: 'rate-limited',
      message:
        'The data MCP server is rate-limiting requests for this user (60 per minute). ' +
        'Wait a minute and retry.',
    });
    process.exit(14);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    fail(`MCP HTTP ${resp.status}: ${text.slice(0, 512)}`, 12);
  }

  const data = await resp.json().catch(() => null);
  if (!data) {
    fail('MCP returned non-JSON body', 12);
  }
  if (data.error) {
    emit({
      status: 'mcp-error',
      method,
      jsonrpc_error: data.error,
    });
    process.exit(12);
  }

  process.stdout.write(JSON.stringify(data.result ?? null) + '\n');
  return data.result ?? null;
}

module.exports = {
  fail,
  emit,
  parseArgs,
  validateUserEmail,
  getUserCognitoRefreshRecord,
  refreshCognitoIdToken,
  mintConsentUrl,
  emitNeedsAuthAndExit,
  callMcp,
  cognitoRefreshSecretId,
  PSD_DATA_MCP_URL,
};
