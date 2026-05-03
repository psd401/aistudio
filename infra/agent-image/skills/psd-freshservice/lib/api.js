/**
 * Shared helpers for the psd-freshservice OpenClaw skill.
 *
 * All commands authenticate with the caller's per-user Freshservice API
 * key, fetched on demand via the psd-credentials skill at:
 *   psd-agent-creds/{env}/user/{email}/freshservice_api_key
 *
 * If the credential is missing, the skill prints a structured prompt
 * asking the user to register their key. Agent then collects the value
 * from the user's next turn and stores it via psd-credentials/put.js.
 *
 * Domain is hardcoded to psd401.freshservice.com — the same value the
 * reference psd-claude-plugins skill uses.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DOMAIN = 'psd401.freshservice.com';
const BASE_URL = `https://${DOMAIN}/api/v2`;

const CREDENTIALS_GET = path.resolve(__dirname, '..', '..', 'psd-credentials', 'get.js');

// Basic email validation — intentionally simple for a CLI tool that only
// accepts PSD domain emails. Rejects path separators (/) as defense-in-depth
// since email values are interpolated into URL paths and Secrets Manager paths.
const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
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
      // Positional args are not supported by psd-freshservice commands.
      // Fail fast rather than silently ignoring.
      fail(`Unexpected positional argument: ${arg}`, 'bad_args');
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

function validateEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email);
}

function requireUser(args) {
  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email address', 'bad_args');
  }
  return args.user;
}

/**
 * Fetch the per-user Freshservice API key from psd-credentials. Returns
 * the key string, or emits a structured registration-prompt and exits
 * non-zero if the credential is not provisioned.
 *
 * Uses execFileSync (blocks the event loop) because each psd-freshservice
 * script is a short-lived CLI process that does one thing then exits — no
 * concurrent I/O to worry about. Do NOT call this from a server context;
 * use the async execFile variant if this is ever imported into a long-lived
 * process.
 */
function getApiKey(userEmail) {
  let stdout = '';
  try {
    stdout = execFileSync('node', [
      CREDENTIALS_GET,
      '--user', userEmail,
      '--name', 'freshservice_api_key',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    promptForKey(userEmail, err.message);
  }

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) promptForKey(userEmail, 'no output from psd-credentials');

  const last = lines[lines.length - 1];
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch (err) {
    promptForKey(userEmail, `psd-credentials returned non-JSON: ${err.message}`);
  }
  if (parsed.error || !parsed.value) {
    promptForKey(userEmail);
  }
  return parsed.value;
}

/**
 * Print the structured prompt the agent should surface to the user when
 * they have not registered their Freshservice API key yet. Exits 2 so
 * the agent can detect the registration-needed state distinctly from
 * other failure modes.
 *
 * Note: The storeCommand passes the secret via --value CLI argument,
 * which is visible in ps output for the process lifetime. This is a
 * known trade-off documented in psd-credentials/SKILL.md § "CLI argument
 * exposure". A future improvement will pipe the value via stdin.
 */
function promptForKey(userEmail, reason) {
  process.stdout.write(JSON.stringify({
    error: 'freshservice_key_missing',
    user: userEmail,
    reason: reason || 'credential not provisioned',
    instructions: [
      'Open https://psd401.freshservice.com/agent/profile and copy your personal API key.',
      'Paste it back to me in chat — I will store it securely in Secrets Manager so I can reuse it next time.',
      'After you paste, I will retry the command via psd-credentials put.',
    ],
    storeCommand: {
      cmd: 'node',
      args: [
        '/home/node/.openclaw/skills/psd-credentials/put.js',
        '--user', userEmail,
        '--name', 'freshservice_api_key',
        '--value', '<PASTE THE KEY HERE>',
      ],
    },
  }, null, 2) + '\n');
  process.exit(2);
}

function authHeader(apiKey) {
  return 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64');
}

async function fsFetch(apiKey, urlPath, init = {}) {
  // Always prepend BASE_URL — never allow callers to bypass the DOMAIN guard
  // by passing an absolute URL. All paths must be relative to the Freshservice
  // API v2 base (e.g. '/tickets/123', not 'https://...').
  const url = `${BASE_URL}${urlPath}`;
  const headers = {
    'Authorization': authHeader(apiKey),
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { __ok: false, status: resp.status, error: `API error ${resp.status}: ${body.slice(0, 500)}` };
  }
  const json = await resp.json().catch(() => ({}));
  return { __ok: true, status: resp.status, data: json };
}

/**
 * Validate and return a numeric ticket ID from parsed args. Freshservice
 * ticket IDs are always positive integers — reject anything else to
 * prevent path-traversal in URL interpolation.
 */
function requireTicketId(args) {
  const id = args.id;
  if (!id || id === true) fail('--id is required', 'bad_args');
  if (!/^\d+$/.test(String(id))) fail('--id must be a numeric ticket ID', 'bad_args');
  return String(id);
}

function parseJsonArg(arg, fieldName = 'JSON argument') {
  if (!arg || arg === true) {
    fail(`${fieldName} required`, 'bad_args');
  }
  try {
    return JSON.parse(arg);
  } catch (err) {
    fail(`Invalid JSON for ${fieldName}: ${err.message}`, 'bad_args');
  }
}

module.exports = {
  DOMAIN,
  BASE_URL,
  fail,
  emit,
  parseArgs,
  validateEmail,
  requireUser,
  getApiKey,
  fsFetch,
  requireTicketId,
  parseJsonArg,
};
