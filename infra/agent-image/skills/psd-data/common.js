/**
 * Shared helpers for the psd-data OpenClaw skill.
 *
 * Authenticates the caller against the PSD data MCP server using a Cognito
 * id_token derived from the user's stored refresh token. On missing or
 * expired refresh token, mints a consent URL via AI Studio's
 * /api/agent/consent-link endpoint (kind: cognito_data) so the agent can
 * post the link in chat and have the user authorize.
 *
 * Credential refresh and MCP transport execute inside the trusted owner-bound
 * web broker. This model-facing helper receives only operation results.
 */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

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
      const blanked = blankLineComment(sql, i);
      out += blanked.text;
      i = blanked.nextIndex;
      continue;
    }
    if (ch === '/' && next === '*') {
      const blanked = blankBlockComment(sql, i);
      out += blanked.text;
      i = blanked.nextIndex;
      continue;
    }
    if (ch === "'") {
      const blanked = blankQuotedString(sql, i);
      out += blanked.text;
      i = blanked.nextIndex;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function blankLineComment(sql, startIndex) {
  let text = '  ';
  let index = startIndex + 2;
  while (index < sql.length && sql[index] !== '\n') {
    text += ' ';
    index++;
  }
  return { text, nextIndex: index };
}

function blankBlockComment(sql, startIndex) {
  let text = '  ';
  let index = startIndex + 2;
  let depth = 1;
  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth++;
      text += '  ';
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth--;
      text += '  ';
      index += 2;
    } else {
      text += sql[index] === '\n' ? '\n' : ' ';
      index++;
    }
  }
  return { text, nextIndex: index };
}

function blankQuotedString(sql, startIndex) {
  const isEscapeString = hasEscapeStringPrefix(sql, startIndex);
  let text = ' ';
  let index = startIndex + 1;
  while (index < sql.length) {
    const current = sql[index];
    if (isEscapeString && current === '\\') {
      text += '  ';
      index += 2;
    } else if (current === "'" && sql[index + 1] === "'") {
      text += '  ';
      index += 2;
    } else if (current === "'") {
      return { text: text + ' ', nextIndex: index + 1 };
    } else {
      text += current === '\n' ? '\n' : ' ';
      index++;
    }
  }
  return { text, nextIndex: index };
}

function hasEscapeStringPrefix(sql, quoteIndex) {
  const prefix = sql[quoteIndex - 1];
  const beforePrefix = sql[quoteIndex - 2];
  return (
    prefix !== undefined &&
    /[eE]/.test(prefix) &&
    (beforePrefix === undefined || !/[A-Za-z0-9_]/.test(beforePrefix))
  );
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
  const response = await requestAgentBroker('/api/agent/credentials', {
    operation: 'psd-data-mcp',
    method,
    params: params || {},
  });
  if (response.status === 'needs-auth') {
    await emitNeedsAuthAndExit(response.reason || 'owner authorization is required');
  }
  if (response.status === 'forbidden') {
    emit({
      status: 'forbidden',
      kind: 'data-permission',
      message:
        'The data MCP server denied access. Most likely the user is not yet ' +
        'registered in the PSD data warehouse userpermissions table. Contact ' +
        'the data team to be added.',
      detail: String(response.detail || '').slice(0, 1024),
    });
    process.exit(13);
  }
  if (response.status === 'rate-limited') {
    emit({
      status: 'rate-limited',
      message:
        'The data MCP server is rate-limiting requests for this user (60 per minute). ' +
        'Wait a minute and retry.',
    });
    process.exit(14);
  }
  if (response.status !== 'ok') fail('PSD data broker returned an invalid result', 12);
  if (response.result && response.result.error) {
    emit({
      status: 'mcp-error',
      method,
      jsonrpc_error: response.result.error,
    });
    process.exit(12);
  }

  process.stdout.write(JSON.stringify(response.result ?? null) + '\n');
  return response.result ?? null;
}

module.exports = {
  fail,
  emit,
  parseArgs,
  rejectAuthorityArgs,
  mintConsentUrl,
  emitNeedsAuthAndExit,
  callMcp,
  findUnqualifiedNumericCasts,
};
