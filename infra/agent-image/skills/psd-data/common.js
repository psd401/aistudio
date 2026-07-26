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
 *   APP_BASE_URL                        — Base URL of the AI Studio web app
 *   AUTH_COGNITO_USER_POOL_ID           — Cognito user pool (info only)
 *   AUTH_COGNITO_CLIENT_ID              — Cognito app client (used for refresh)
 *   AUTH_COGNITO_REGION                 — Cognito region (defaults to AWS_REGION)
 *   PSD_DATA_MCP_URL                    — MCP server JSON-RPC endpoint
 */

'use strict';

const {
  getOwnerCredential,
  requestAgentBroker,
} = require('../_shared/agent-broker');

const REGION = process.env.AWS_REGION || 'us-east-1';
const COGNITO_REGION =
  process.env.AUTH_COGNITO_REGION || REGION;
const COGNITO_CLIENT_ID = process.env.AUTH_COGNITO_CLIENT_ID || '';
const PSD_DATA_MCP_URL = process.env.PSD_DATA_MCP_URL || '';

function fail(message, code = 1) {
  process.stderr.write(`psd-data: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// psd-data-mcp rejects NUMERIC/DECIMAL casts that don't specify precision
// (see SKILL.md's "Hard rules"). This is the leading, medium-confidence
// hypothesis for FS#162394 / issue #1106 (numeric columns disappearing from
// query results/CSV exports) — the external Lambda's own source couldn't be
// inspected during triage, so this check guards against the suspected
// trigger, it does not confirm the server's actual behavior.
const CAST_OPEN_RE = /\b(?:TRY_)?CAST\s*\(/gi;
const UNQUALIFIED_CAST_TAIL_RE = /\bAS\s+(NUMERIC|DECIMAL)\s*$/i;
const UNQUALIFIED_SHORTHAND_RE = /::\s*(NUMERIC|DECIMAL)\b(?!\s*\()/gi;

// Blank out single-quoted string literal contents and SQL comments
// (preserving length/offsets so match indices still line up with the
// original string) so neither regex above fires on SQL text that merely
// *mentions* a cast inside a literal or a comment, e.g.
// `WHERE note LIKE '%CAST(x AS NUMERIC)%'` or `-- CAST(x AS NUMERIC)`.
// Handles '' doubled-quote escapes in all string literals, and backslash
// escapes only inside E'...' literals (matching Postgres's actual
// standard_conforming_strings=on semantics); does not handle dollar-quoted
// strings (rare in this context).
function blankStringLiterals(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      out += '  ';
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      // Postgres block comments nest, so track depth rather than stopping
      // at the first `*/` — otherwise a nested `/* ... */` would end the
      // blanked region early and expose the remaining "still-outer-comment"
      // text as live SQL to scan.
      let depth = 1;
      out += '  ';
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          out += '  ';
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          out += '  ';
          i += 2;
        } else {
          out += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }

    if (ch === "'") {
      // Postgres only applies backslash-escaping inside E'...' literals
      // (standard_conforming_strings = on, the default, makes backslash a
      // plain character in a bare '...' literal — only '' doubling escapes
      // a quote). Detect the E prefix so a plain '...' literal containing a
      // stray backslash-quote sequence terminates where Postgres would
      // actually terminate it, rather than swallowing the rest of the SQL.
      const prevChar = sql[i - 1];
      const prevPrevChar = sql[i - 2];
      const isEscapeString =
        prevChar !== undefined &&
        /[eE]/.test(prevChar) &&
        (prevPrevChar === undefined || !/[A-Za-z0-9_]/.test(prevPrevChar));
      out += ' ';
      i++;
      while (i < sql.length) {
        const curr = sql[i];
        if (isEscapeString && curr === '\\') {
          out += '  ';
          i += 2;
        } else if (curr === "'" && sql[i + 1] === "'") {
          out += '  ';
          i += 2;
        } else if (curr === "'") {
          out += ' ';
          i++;
          break;
        } else {
          out += curr === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

// Find the index of the ')' that closes the '(' at openIndex, accounting for
// nested parens (e.g. `CAST(ROUND(x, 2) AS NUMERIC)`). Returns -1 if
// unmatched (malformed SQL — the MCP server will reject it on its own).
function findMatchingClose(sql, openIndex) {
  let depth = 1;
  for (let i = openIndex + 1; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scan a SQL string for NUMERIC/DECIMAL casts with no explicit precision.
 * Only flags actual `CAST(...)`/`TRY_CAST(...)` calls and `::TYPE` shorthand
 * — not bare `... AS numeric`/`... AS decimal` column aliases (which share
 * the same `AS <TYPE>)` text but aren't a cast at all) — and ignores
 * anything inside a string literal or a SQL comment. Returns the matched
 * fragments (empty if none).
 */
function findUnqualifiedNumericCasts(sql) {
  if (typeof sql !== 'string') return [];
  const scan = blankStringLiterals(sql);
  const matches = [];

  CAST_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = CAST_OPEN_RE.exec(scan))) {
    const openParenIndex = m.index + m[0].length - 1;
    const closeParenIndex = findMatchingClose(scan, openParenIndex);
    if (closeParenIndex === -1) continue;
    const inner = scan.slice(openParenIndex + 1, closeParenIndex);
    if (UNQUALIFIED_CAST_TAIL_RE.test(inner)) {
      matches.push(
        sql.slice(m.index, closeParenIndex + 1).replace(/\s+/g, ' ').trim()
      );
    }
  }

  UNQUALIFIED_SHORTHAND_RE.lastIndex = 0;
  while ((m = UNQUALIFIED_SHORTHAND_RE.exec(scan))) {
    matches.push(sql.slice(m.index, m.index + m[0].length).trim());
  }

  return matches;
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

function rejectAuthorityArgs(args) {
  for (const name of ['user', 'owner_email', 'user_email', 'user_id']) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      fail(`--${name.replace(/_/g, '-')} is not accepted; identity comes from the signed invocation`);
    }
  }
}

/**
 * Read the user's stored Cognito refresh-token record. Returns null when
 * the secret does not yet exist (user hasn't completed the consent flow).
 *
 * Record shape (written by `lib/auth/agent-token-sync.ts`):
 *   { refresh_token, obtained_at, user_pool_id, client_id, region }
 */
async function getUserCognitoRefreshRecord() {
  const credential = await getOwnerCredential('cognito-refresh');
  if (!credential) return null;
  try {
    return JSON.parse(credential.value);
  } catch {
    throw new Error('Stored Cognito credential is not valid JSON');
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
async function mintConsentUrl() {
  const data = await requestAgentBroker(
    '/api/agent/consent-link',
    { kind: 'cognito_data' },
  );
  if (!data.url) throw new Error('Consent-link API returned no URL');
  return data.url;
}

/**
 * Emit a needs-auth payload and exit 10. Encapsulates the chat-format
 * conventions (psd-rules rule 9) so callers don't have to duplicate them.
 */
async function emitNeedsAuthAndExit(reason) {
  let consentUrl;
  try {
    consentUrl = await mintConsentUrl();
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
 * Side effects: writes the JSON-RPC result to stdout on success; emits a
 * needs-auth payload + exits 10 if no token; emits a structured error and
 * exits non-zero otherwise. Callers do not need to handle errors.
 */
async function callMcp(method, params) {
  if (!PSD_DATA_MCP_URL) {
    fail('PSD_DATA_MCP_URL is not set');
  }
  if (!COGNITO_CLIENT_ID) {
    fail('AUTH_COGNITO_CLIENT_ID is not set');
  }

  const record = await getUserCognitoRefreshRecord();
  if (!record || !record.refresh_token) {
    await emitNeedsAuthAndExit(
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
    await emitNeedsAuthAndExit('MCP server rejected token (401)');
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
  rejectAuthorityArgs,
  getUserCognitoRefreshRecord,
  refreshCognitoIdToken,
  mintConsentUrl,
  emitNeedsAuthAndExit,
  callMcp,
  findUnqualifiedNumericCasts,
  PSD_DATA_MCP_URL,
};
