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
const fs = require('node:fs');

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

// Two slots per user (#912 Phase 1 — see secrets-manager.ts):
//   'agent_account' = OAuth on agnt_<uniqname>@psd401.net (broad scopes)
//   'user_account'  = OAuth on the human user (scopes:
//                     gmail.modify, calendar, tasks, drive.file)
//
// The user_account path is suffixed (-user) so revocation tools can iterate
// by prefix and tell the slots apart.
const WORKSPACE_SECRET_PATH = (email, kind = 'agent_account') => {
  const suffix = kind === 'user_account' ? '-user' : '';
  return `psd-agent-creds/${ENVIRONMENT}/user/${email}/google-workspace${suffix}`;
};

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
 *
 * `kind` selects which slot to read:
 *   'agent_account' (default) — agent's own identity, broad scopes
 *   'user_account'            — user's own identity, narrow Phase 1 scopes
 */
async function getUserWorkspaceToken(userEmail, kind = 'agent_account') {
  try {
    return await getSecretJson(WORKSPACE_SECRET_PATH(userEmail, kind));
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
 * Ask the Next.js app for a fresh, signed consent URL for the given owner
 * and slot kind. The kind determines which scopes Google will be asked for
 * and which login_hint is set in the OAuth URL.
 */
async function mintConsentUrl(ownerEmail, kind = 'agent_account') {
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
    body: JSON.stringify({ ownerEmail, kind }),
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
 * Return the value of the `--json` argument from an argv token array — i.e. the
 * exact string gws receives (quotes already stripped by splitCommand). Returns
 * null if there is no `--json` flag with a following value. Security-sensitive
 * consumers (the Phase 1 gate exception) MUST read the payload from here rather
 * than re-scanning the raw command string, so what is inspected is identical to
 * what executes.
 */
function extractJsonArg(tokens) {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === '--json') return tokens[i + 1];
  }
  return null;
}

/**
 * Exec gws with GOOGLE_WORKSPACE_CLI_TOKEN set. Streams stdout; returns exit
 * code. gws ignores GOOGLE_ACCESS_TOKEN — must be GOOGLE_WORKSPACE_CLI_TOKEN
 * per the gws README "Pre-obtained Access Token" section.
 */
function execGws(commandString, accessToken) {
  const tokens = splitCommand(commandString);
  if (tokens.length === 0) {
    fail('--command is empty');
  }
  // Call the real binary directly. In the agent container the model-facing
  // `gws` on PATH is a refuse-by-default wrapper (bin/gws-wrapper.sh) that
  // blocks direct data access; run.js is the only sanctioned caller, so it
  // must reach the unwrapped binary at /usr/local/bin/gws.real. Local/dev
  // images that ship no wrapper fall back to `gws` on PATH.
  const REAL_GWS = '/usr/local/bin/gws.real';
  const bin = fs.existsSync(REAL_GWS) ? REAL_GWS : 'gws';
  const result = spawnSync(bin, tokens, {
    env: { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: accessToken },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    fail(`Failed to exec gws: ${result.error.message}`, 2);
  }
  return result.status == null ? 1 : result.status;
}

// ============================================================================
// Phase 1 hard gates (#912 Phase 1)
// ============================================================================
//
// These are the operations the skill refuses regardless of how the model
// phrases the gws command. The model cannot bypass them with prompt creativity,
// scope changes, or alternate spellings — the gate is a regex match on the
// argv-tokenized command before exec.
//
// Phase 1 product policy:
//   - No sending mail (drafts only — user must hit send themselves).
//     Note: the OAuth grant on the user_account scope is now gmail.modify
//     (upgraded from gmail.compose) so the agent can archive/label on the
//     user's behalf. gmail.modify ALSO carries send capability at the API
//     level, so the regex below is now the sole barrier against the agent
//     actually putting a message on the wire. Treat this list as load-bearing.
//   - No deleting anything (mail, events, files, tasks)
//   - Archive / label-modify allowed via gmail.users.messages.modify;
//     trashing / permanent delete still blocked below.
//
// Each entry: {pattern: regex, reason: human-readable explanation}.
// `pattern` matches against the SPACE-JOINED argv tokens, lowercased — so
// `gws gmail users messages send` and `gws gmail.users.messages.send` both
// trigger the same rule.
const PHASE1_FORBIDDEN = [
  // Send mail — any path that puts a message on the wire
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+send\b/i,
    reason: 'sending mail (Phase 1: drafts only)' },
  { pattern: /\bgmail[\s.]+users[\s.]+drafts[\s.]+send\b/i,
    reason: 'sending a draft (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?send\b/i,
    reason: 'sending mail via the +send helper (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?reply\b/i,
    reason: 'replying via the +reply helper (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?reply-all\b/i,
    reason: 'replying-all via the helper (Phase 1: drafts only)' },
  { pattern: /^\s*gmail[\s.]+\+?forward\b/i,
    reason: 'forwarding via the helper (Phase 1: drafts only)' },

  // Delete mail / events / files
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+delete\b/i,
    reason: 'permanently deleting mail (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+trash\b/i,
    reason: 'trashing mail (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+messages[\s.]+batchDelete\b/i,
    reason: 'batch-deleting mail (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+drafts[\s.]+delete\b/i,
    reason: 'deleting a draft (Phase 1: never destructive)' },
  { pattern: /\bgmail[\s.]+users[\s.]+threads[\s.]+(delete|trash)\b/i,
    reason: 'deleting/trashing a thread (Phase 1: never destructive)' },
  { pattern: /\bcalendar[\s.]+events[\s.]+delete\b/i,
    reason: 'deleting calendar events (Phase 1: never destructive)' },
  { pattern: /\bcalendar[\s.]+calendars[\s.]+delete\b/i,
    reason: 'deleting a calendar (Phase 1: never destructive)' },
  { pattern: /\bdrive[\s.]+files[\s.]+delete\b/i,
    reason: 'deleting Drive files (Phase 1: never destructive)' },
  { pattern: /\bdrive[\s.]+files[\s.]+emptyTrash\b/i,
    reason: 'emptying Drive trash (Phase 1: never destructive)' },
  { pattern: /\btasks[\s.]+tasks[\s.]+delete\b/i,
    reason: 'deleting tasks (Phase 1: never destructive)' },
  { pattern: /\btasks[\s.]+tasklists[\s.]+delete\b/i,
    reason: 'deleting tasklists (Phase 1: never destructive)' },

  // Sharing externally / changing permissions on user data
  { pattern: /\bdrive[\s.]+permissions[\s.]+(create|update|delete)\b/i,
    reason: 'modifying Drive sharing permissions (Phase 1: no permission changes)' },
];

// gws gmail "helper" verbs that put a message on the wire. The `+`-prefixed
// forms are unambiguous (they never appear as a search-query value), so they
// are blocked wherever they appear in the argv. The bare forms (`gmail send`)
// are only blocked in the verb slot immediately after `gmail`, so a legitimate
// `--query 'reply'` search is not falsely refused. (REV-COR-350)
const GMAIL_PLUS_SEND_HELPERS = new Set(['+send', '+reply', '+reply-all', '+forward']);
const GMAIL_BARE_SEND_HELPERS = new Set(['send', 'reply', 'reply-all', 'forward']);
const GMAIL_SEND_HELPER_REASON =
  'sending/replying/forwarding mail via a gmail helper (Phase 1: drafts only)';

/**
 * Detect the gmail send/reply/forward helper forms from argv tokens. These
 * escape the start-anchored PHASE1_FORBIDDEN patterns when the command is
 * prefixed with the `gws` program token or a flag before the verb
 * (`gws gmail +send`, `gmail --to x +send`). Returns a reason string to refuse,
 * or null. Requires a `gmail` token to be present so unrelated commands are
 * unaffected.
 */
function detectGmailSendHelper(tokens) {
  const lower = tokens.map((t) => t.toLowerCase());
  const gmailIdx = lower.indexOf('gmail');
  if (gmailIdx === -1) return null;
  if (lower.some((t) => GMAIL_PLUS_SEND_HELPERS.has(t))) return GMAIL_SEND_HELPER_REASON;
  const verb = lower[gmailIdx + 1];
  if (verb && GMAIL_BARE_SEND_HELPERS.has(verb)) return GMAIL_SEND_HELPER_REASON;
  return null;
}

/**
 * Narrow exception to the `drive.permissions.create` block: the agent is
 * permitted to share files it owns (scope === 'agent_account') back to the
 * caller who initiated the conversation, as `reader` or `commenter` only.
 *
 * Rationale: when the agent creates artifacts on a user's behalf — investigation
 * reports, drafts, generated docs — it stores them in its own agent_account
 * Drive (because user_account scopes are intentionally narrow). Without this
 * exception, the user has no way to view the artifact, since the broad
 * `drive.permissions.create` block prevents even hand-back-to-owner sharing.
 *
 * Hard constraints (ALL must be true to allow):
 *   - context.scope is 'agent_account'  (sharing FROM the agent's own Drive)
 *   - context.ownerEmail matches the permission's emailAddress (caller only;
 *     no third-party shares, no domain shares, no anyone-with-link)
 *   - permission.type === 'user'        (no domain / group / anyone)
 *   - permission.role ∈ {reader, commenter}  (no writer/owner transfer)
 *
 * Returns true if the share request is the narrow caller-only handoff;
 * false otherwise. False means fall through to the existing block.
 */
function isShareToCallerHandoff(tokens, context) {
  if (!context || context.scope !== 'agent_account' || !context.ownerEmail) {
    return false;
  }
  // Must be the create variant — update/delete remain blocked. Match against
  // the executed tokenization (REV-COR-346), not the raw string.
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const createRe = /\bdrive[\s.]+permissions[\s.]+create\b/i;
  if (!createRe.test(spaceJoined) && !createRe.test(dotJoined)) {
    return false;
  }

  // Read the --json payload from the argv token that actually executes, so the
  // exception cannot be granted on a benign-looking payload that differs from
  // what gws receives (REV-COR-346).
  const jsonStr = extractJsonArg(tokens);
  if (!jsonStr) return false;
  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    return false;
  }

  // gws drive permissions create wraps the permission under `resource`,
  // `requestBody`, or accepts the fields at top level depending on the
  // invocation style. Look in all three.
  const perm = payload.resource || payload.requestBody || payload;
  if (!perm || typeof perm !== 'object') return false;

  const type = typeof perm.type === 'string' ? perm.type.toLowerCase() : '';
  const role = typeof perm.role === 'string' ? perm.role.toLowerCase() : '';
  const emailAddress = typeof perm.emailAddress === 'string'
    ? perm.emailAddress.toLowerCase()
    : '';

  if (type !== 'user') return false;
  if (role !== 'reader' && role !== 'commenter') return false;
  if (emailAddress !== context.ownerEmail.toLowerCase()) return false;

  return true;
}

/**
 * Test the gws command against Phase 1 forbidden patterns. Returns
 * `{allowed: true}` if the command can proceed, or
 * `{allowed: false, reason: '<short description>'}` if it must be refused.
 *
 * The check is intentionally permissive on whitespace and dot-vs-space
 * separators so different gws invocation styles all hit the same rules.
 *
 * Optional `context` argument enables narrow per-request exceptions:
 *   { scope: 'agent_account' | 'user_account', ownerEmail: '<caller@…>' }
 * Currently used for the share-to-caller handoff on Drive permissions.
 */
function enforcePhase1Gates(commandString, context) {
  if (!commandString || typeof commandString !== 'string') {
    return { allowed: true };
  }
  // SECURITY (REV-COR-346): match against the SAME tokenization that executes.
  // execGws runs splitCommand(commandString), which strips quotes. Matching the
  // raw string let an attacker insert a quote into a forbidden verb
  // (`messages 'send'`) so the regex missed it while splitCommand reassembled
  // the exact blocked argv. We tokenize first and test the space- and
  // dot-joined argv, so the gate sees precisely what gws will receive.
  const tokens = splitCommand(commandString);
  const spaceJoined = tokens.join(' ').toLowerCase();
  const dotJoined = tokens.join('.').toLowerCase();
  const hits = (pattern) => pattern.test(spaceJoined) || pattern.test(dotJoined);

  for (const { pattern, reason } of PHASE1_FORBIDDEN) {
    if (hits(pattern)) {
      // Narrow exception: agent shares its own file with the caller, read-only.
      if (
        hits(/\bdrive[\s.]+permissions[\s.]+create\b/i) &&
        isShareToCallerHandoff(tokens, context)
      ) {
        return { allowed: true };
      }
      return { allowed: false, reason };
    }
  }

  // Helper-form send/reply/forward (REV-COR-350) — `gws gmail +send`,
  // `gmail --to x +send` escape the start-anchored patterns above.
  const helperReason = detectGmailSendHelper(tokens);
  if (helperReason) {
    return { allowed: false, reason: helperReason };
  }

  return { allowed: true };
}

// ============================================================================
// Marker injection (#912 Phase 1)
// ============================================================================
//
// Every write operation gets an automatic marker so artifacts the agent
// touches are auditable as agent-touched. The model does not have to
// remember to add markers — they're injected here.
//
// Inject points:
//   - Calendar event create/update: prepend description with marker
//   - Gmail draft create: append body with marker + X-PSD-Agent header
//   - Drive file create: filename prefix [Agent] + appProperties marker
//   - Tasks: enforce 'Your Agent' tasklist
//
// These transforms operate on the JSON-encoded params. The skill receives a
// command string like:
//   calendar events insert --json '{"summary":"x","description":"y"}'
// We parse the --json blob, mutate it, re-stringify.

const AGENT_MARKER_TEXT = '🤖 Created by your agent';

function markerWithDate() {
  const today = new Date().toISOString().slice(0, 10);
  return `${AGENT_MARKER_TEXT} on ${today}.`;
}

/**
 * Inject markers into the gws command string. Returns the (possibly
 * modified) command. If the command doesn't match a write-with-markable-
 * payload pattern, returns the input unchanged.
 *
 * Best-effort: if the JSON payload is malformed or the command shape is
 * unexpected, we pass the original through rather than fail. The skill
 * surfaces auth errors and Phase 1 gate violations explicitly; quietly
 * skipping a marker on a malformed command is the lesser harm.
 */
function injectMarkers(commandString) {
  if (!commandString || typeof commandString !== 'string') return commandString;

  // Calendar events insert/update: prepend description with marker.
  if (/\bcalendar[\s.]+events[\s.]+(insert|update|patch)\b/i.test(commandString)) {
    return mutateJsonField(commandString, (obj) => {
      const marker = markerWithDate();
      obj.description = obj.description
        ? `${marker}\n\n${obj.description}`
        : marker;
      return obj;
    });
  }

  // Gmail drafts create: marker the body and add an identifying header.
  if (/\bgmail[\s.]+users[\s.]+drafts[\s.]+create\b/i.test(commandString)) {
    return mutateJsonField(commandString, (obj) => {
      // gws drafts.create wraps the message under .message.raw (base64url).
      // Skip raw mutation here — too brittle. The +draft helper takes
      // body/subject directly and is the recommended path; we marker the
      // body field if present. For raw payloads the marker rule is
      // enforced via SKILL.md prompt guidance instead.
      if (obj.message && typeof obj.message.body === 'string') {
        obj.message.body = `${obj.message.body}\n\n— Drafted by your agent. Review before sending.`;
      }
      return obj;
    });
  }

  // Drive files create: prefix filename + appProperties marker
  if (/\bdrive[\s.]+files[\s.]+create\b/i.test(commandString)) {
    return mutateJsonField(commandString, (obj) => {
      if (obj.name && !obj.name.startsWith('[Agent] ')) {
        obj.name = `[Agent] ${obj.name}`;
      }
      obj.appProperties = obj.appProperties || {};
      obj.appProperties.psdAgentCreated = 'true';
      return obj;
    });
  }

  // Tasks: enforce 'Your Agent' tasklist on tasks.insert if not provided
  // (the tasklist must exist; create-on-demand is left to the model so the
  // SKILL.md flow stays explicit). For now, no auto-mutation here — the
  // SKILL.md guidance and Phase 1 absolutes ensure the model uses the
  // right tasklist explicitly.

  return commandString;
}

/**
 * Find the --json '{...}' argument in a gws command string and apply
 * `mutator` to the parsed object. Re-encode and splice back.
 *
 * Returns the original string if no --json arg or the JSON parse fails.
 */
function mutateJsonField(commandString, mutator) {
  // Match --json followed by a single-quoted or double-quoted JSON object.
  // The simple/robust approach: find --json, then balanced-brace scan from
  // the next non-quote character forward.
  const jsonFlagIdx = commandString.search(/--json\s+['"]?\{/);
  if (jsonFlagIdx === -1) return commandString;

  // Find the start of the JSON object (`{`). Skip the `--json` token,
  // any whitespace, and any opening quote.
  let i = jsonFlagIdx + '--json'.length;
  while (i < commandString.length && /\s/.test(commandString[i])) i++;
  let openQuote = '';
  if (commandString[i] === "'" || commandString[i] === '"') {
    openQuote = commandString[i];
    i++;
  }
  const jsonStart = i;
  if (commandString[jsonStart] !== '{') return commandString;

  // Brace-balance scan to find the matching close.
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;
  let jsonEnd = -1;
  for (let j = jsonStart; j < commandString.length; j++) {
    const ch = commandString[j];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) {
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { jsonEnd = j; break; }
    }
  }
  if (jsonEnd === -1) return commandString;

  const jsonStr = commandString.slice(jsonStart, jsonEnd + 1);
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return commandString;
  }

  let mutated;
  try {
    mutated = mutator(obj);
  } catch {
    return commandString;
  }

  const newJson = JSON.stringify(mutated);
  // Preserve the original opening quote style so shell parsing is unchanged.
  const closeQuote = openQuote;
  return (
    commandString.slice(0, jsonStart) +
    newJson +
    (closeQuote ? '' : '') +
    commandString.slice(jsonEnd + 1).replace(/^['"]?/, closeQuote ? closeQuote : '')
  );
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
  enforcePhase1Gates,
  injectMarkers,
  PHASE1_FORBIDDEN,
};
