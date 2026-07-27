/**
 * Shared helpers for the psd-freshservice OpenClaw skill.
 *
 * READ/WRITE contract:
 *   - Every Freshservice call goes through a fixed web-tier operation that
 *     allowlists (method, path) and attaches the owner's API key server-side.
 *   - No provider credential enters this model-launched process.
 *
 * WHY THIS WAS REWRITTEN. The skill used to exec psd-credentials/get.js to read
 * the key in plaintext. #1353 removed plaintext credential access and deleted
 * that script, but this skill was never migrated — so every command has been
 * dead since, failing before it even checked whether a key was provisioned.
 * Worse, the failure surfaced as "your Freshservice credential is missing",
 * which blamed the user for a broken skill.
 *
 * The owner is derived from the proxy-signed invocation context server-side;
 * there is no --user to spoof. Mirrors psd-redrover, which was migrated at the
 * time #1353 landed.
 *
 * Domain is fixed at psd401.freshservice.com in the BROKER, not here.
 */

'use strict';

const { requestAgentBroker } = require('../../_shared/agent-broker');

// Opaque stand-in threaded through the command scripts in place of the real
// key, which now lives only in the web tier. Never a secret.
const BROKER_MANAGED_KEY = Object.freeze({ brokerManaged: true });

// Basic email validation — intentionally simple for a CLI tool that only
// accepts PSD domain emails. Rejects path separators (/) as defense-in-depth
// since email values are interpolated into URL paths and Secrets Manager paths.
// Keep in sync with: psd-credentials/common.js and psd-image-gen/generate.js.
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
 * Credential handle for the call sites.
 *
 * The key no longer exists in this process — the broker holds it. Every
 * command still calls `getApiKey(userEmail)` and passes the result to
 * `fsFetch`, so this returns an opaque marker rather than a secret, keeping
 * all 13 command scripts unchanged. `fsFetch` ignores it.
 *
 * Deliberately NOT deleted from the call sites: threading a broker client
 * through every script would be a wide, riskier diff for no behavioural gain,
 * and leaving the parameter in place keeps the shape ready if a future
 * operation ever needs a per-call handle.
 */
function getApiKey(userEmail) {
  void userEmail;
  return BROKER_MANAGED_KEY;
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
        '/opt/psd-skills/psd-credentials/put.js',
        '--name', 'freshservice_api_key',
        '--value', '%%VALUE%%',
      ],
      // The %%VALUE%% marker is where the agent must substitute the user's
      // pasted API key. Using a distinctive marker (vs. natural language like
      // "<PASTE THE KEY HERE>") makes substitution unambiguous in the args
      // array and harder for the agent to mis-splice.
      substitution: { '%%VALUE%%': 'Replace with the user-supplied Freshservice API key' },
    },
  }, null, 2) + '\n');
  process.exit(2);
}

/**
 * Perform one Freshservice call through the owner-bound broker.
 *
 * Signature is unchanged so all 13 command scripts keep working; `apiKey` is
 * now the opaque marker from getApiKey() and is ignored — the real key never
 * reaches this process. The broker allowlists (method, path) server-side, so
 * an endpoint this skill does not already use is rejected there rather than
 * silently signed with the owner's credential.
 *
 * Returns the same `{__ok, status, data|error}` envelope as before, including
 * the distinct 429 shape the callers already branch on.
 */
function parseFetchBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch (err) {
    fail(`fsFetch: body is not valid JSON: ${err.message}`, 'bad_args');
  }
}

function brokerRequestFailure(err) {
  const status = (err && err.status) || 0;
  if (status === 403) {
    return {
      __ok: false,
      status: 403,
      error: 'Freshservice access is not granted for this account.',
      code: 'freshservice_forbidden',
    };
  }
  return {
    __ok: false,
    status,
    error: `Freshservice broker request failed: ${err && err.message}`,
    code: 'freshservice_broker_error',
  };
}

async function requestFreshserviceBroker(urlPath, method, parsedBody) {
  try {
    const result = await requestAgentBroker('/api/agent/credentials', {
      operation: 'freshservice',
      path: urlPath,
      method,
      ...(parsedBody === undefined ? {} : { body: parsedBody }),
    });
    return { result };
  } catch (err) {
    return { failure: brokerRequestFailure(err) };
  }
}

function normalizeFreshserviceResult(result) {
  // The owner has never registered a key. NOT an error — surface the
  // registration prompt the agent knows how to act on.
  if (result && result.code === 'credential_missing') {
    promptForKey(null, 'credential not provisioned');
  }
  if (result && result.code === 'rate_limited') {
    return {
      __ok: false,
      status: 429,
      error: `Freshservice rate limit exceeded. Retry after ${result.retryAfter}s.`,
      code: 'freshservice_rate_limited',
    };
  }
  if (!result || result.ok !== true) {
    const status = (result && result.status) || 0;
    return {
      __ok: false,
      status,
      error: `API error ${status}: ${JSON.stringify((result && result.data) ?? {}).slice(0, 500)}`,
    };
  }
  return { __ok: true, status: result.status, data: result.data ?? {} };
}

async function fsFetch(apiKey, urlPath, init = {}) {
  void apiKey;
  // Kept from the original: a path must be relative and start with '/'. The
  // broker re-validates, but failing here gives the caller the precise
  // bad_args exit instead of a generic broker rejection.
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) {
    fail(`fsFetch: urlPath must start with '/' (got: ${String(urlPath).slice(0, 50)})`, 'bad_args');
  }

  const method = (init.method || 'GET').toUpperCase();
  const parsedBody = parseFetchBody(init.body);
  const outcome = await requestFreshserviceBroker(urlPath, method, parsedBody);
  return 'failure' in outcome
    ? outcome.failure
    : normalizeFreshserviceResult(outcome.result);
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
  // DOMAIN/BASE_URL are intentionally NOT exported any more: the Freshservice
  // host is fixed in the broker, and re-exporting it here invited a caller to
  // build its own URL and bypass the allowlist. Nothing outside lib/ used them.
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
