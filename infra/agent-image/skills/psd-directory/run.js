#!/usr/bin/env node
/**
 * run.js — psd-directory skill entrypoint (#1239)
 *
 * Resolve a district identity instead of guessing:
 *
 *   node run.js --email someone@psd401.net
 *   node run.js --chat-id users/116264913639920976203
 *
 * NO --user FLAG, BY DESIGN. The owner is derived from the proxy-signed
 * invocation context on the server side (#1353), never from something the
 * model can type. An earlier draft of this skill took `--user` and minted a
 * Google token inside the container; both are exactly what the security
 * remediation removed, so the lookup now happens server-side and this process
 * only ever sees the shaped person record.
 *
 * Output is a single JSON line on stdout:
 *   {"found":true,"personId":"...","displayName":"...","email":"...",
 *    "title":"...","department":"...","organization":"...","cached":false}
 *   {"found":false,"query":"...","reason":"not in directory"}
 *
 * A miss is exit 0 with found:false — "this person is not in the directory"
 * is an ANSWER the agent must be able to act on, not a failure.
 *
 * Exit codes:
 *   0  success (including a found:false miss)
 *   1  usage / bad input
 *   2  lookup failed (unexpected People API error)
 *   12 transport error (broker unreachable, or People API 5xx)
 *   14 account-provisioning (the agnt_ account is being created; retry later)
 *   16 directory-sharing-disabled — the Workspace admin console setting
 *      "External Directory Sharing" is restrictive. Its own code because NO
 *      code change or retry fixes it: it is an admin action, and it looks
 *      identical to a permissions bug unless the message names the setting.
 *   17 insufficient-scope — the agent token lacks directory.readonly.
 */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

const USAGE = `psd-directory — resolve a district email or Chat user id to a real person

Usage:
  run.js --email <address>
  run.js --chat-id <users/{id} | {id}>

Options:
  --email     Resolve an email address to a directory person.
  --chat-id   Resolve a Chat users/{id} (or bare numeric id) to a person.
  --no-cache  Bypass the server-side lookup cache for this call.
  --help      Show this message.

Exactly one of --email / --chat-id is required. The owner comes from the
signed invocation context — there is no --user flag.`;

function fail(message, code = 1) {
  process.stderr.write(`psd-directory: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Minimal argv parse — this skill takes only long flags. */
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
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

/**
 * Map the server's typed status onto this skill's documented exit codes.
 * Exported for testing — run.js cannot be loaded wholesale in unit tests
 * because it executes main() on require.
 */
function exitCodeForStatus(status, httpStatus) {
  switch (status) {
    case 'account-not-provisioned':
      return 14;
    case 'DIRECTORY_SHARING_DISABLED':
      return 16;
    case 'INSUFFICIENT_SCOPE':
      return 17;
    case 'TRANSPORT':
      return 12;
    case 'INVALID_INPUT':
      return 1;
    default:
      // The HTTP fallback applies ONLY when the body carried no typed status
      // at all — i.e. the failure happened BELOW the route (the relay's own
      // 502/503, or a mint-boundary error the route never saw). Those are
      // transient infrastructure and map to the retryable 12.
      //
      // A typed-but-unrecognized status is a DEFINITE answer from the route
      // and must stay 2. The route returns permanent failures like
      // LOOKUP_FAILED and FORBIDDEN with HTTP 502, so keying off the status
      // code alone would advertise a People API 400 as a transient outage.
      if (status !== null && status !== undefined) return 2;
      return typeof httpStatus === 'number' && httpStatus >= 500 ? 12 : 2;
  }
}

function handleErrorResponse(response, fallbackMessage, httpStatus) {
  const status = response && typeof response.status === 'string' ? response.status : null;
  const code = exitCodeForStatus(status, httpStatus);
  if (code === 14) {
    emit({ status: 'account-provisioning' });
    process.exit(14);
  }
  if (code === 16) {
    fail(
      'the Workspace directory is not shared with API callers. An admin must set ' +
        'Directory > Directory settings > Sharing settings > External Directory Sharing to ' +
        '"Organization data and authenticated user basic profile fields". ' +
        `(Google said: ${(response && response.error) || 'no detail'})`,
      16
    );
  }
  fail((response && response.error) || fallbackMessage, code);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const wantEmail = typeof args.email === 'string' ? args.email : null;
  const wantChatId = typeof args.chat_id === 'string' ? args.chat_id : null;
  if (!wantEmail && !wantChatId) fail('one of --email or --chat-id is required');
  if (wantEmail && wantChatId) fail('--email and --chat-id are mutually exclusive');

  const payload = wantEmail ? { email: wantEmail } : { chatId: wantChatId };
  if (args.no_cache === true) payload.noCache = true;

  let result;
  try {
    result = await requestAgentBroker('/api/agent/directory-lookup', payload);
  } catch (err) {
    // The broker helper throws on any non-2xx and attaches the parsed body,
    // which is where the server puts its typed status.
    if (err && err.responseBody) {
      handleErrorResponse(err.responseBody, err.message, err.status);
      return 2;
    }
    fail(`directory lookup failed: ${err && err.message}`, 12);
    return 12;
  }

  // `cached: false` first so a server result that omits the field still
  // reports it explicitly — SKILL.md documents `"cached":false` on fresh
  // results, and callers use its presence to tell a fresh answer from a
  // malformed or legacy response. A cache hit sets `cached: true` and the
  // spread overrides.
  emit({ cached: false, ...result });
  return 0;
}

module.exports = { exitCodeForStatus, parseArgs };

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => fail(`unexpected error: ${err && err.message}`, 2));
}
