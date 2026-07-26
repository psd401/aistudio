#!/usr/bin/env node
/**
 * run.js — psd-directory skill entrypoint (#1239)
 *
 * Resolve a district identity instead of guessing:
 *
 *   node run.js --user <owner@psd401.net> --email <someone@psd401.net>
 *   node run.js --user <owner@psd401.net> --chat-id users/1162649136399...
 *
 * Authentication uses the AGENT slot only. `directory.readonly` is already in
 * AGENT_DWD_SCOPES, so this needs no new scope, no consent flow, and no admin
 * role — the token comes from the same DWD broker psd-workspace uses.
 * (The user slot also carries directory.readonly, but resolving "who is this
 * district person" is agent-context work and does not need the human's
 * consent grant; keeping it on one slot keeps the failure modes to one set.)
 *
 * Output is a single JSON line on stdout:
 *   {"found":true,"personId":"...","displayName":"...","email":"...",
 *    "title":"...","department":"...","organization":"...","cached":false}
 *   {"found":false,"query":"...","reason":"not in directory"}
 *
 * A miss is exit 0 with found:false — "this person is not in the directory"
 * is an ANSWER, not a failure, and the agent must be able to act on it
 * without treating it as an error.
 *
 * Exit codes:
 *   0  success (including a found:false miss)
 *   1  usage / config error
 *   2  lookup failed (unexpected People API error)
 *   12 transport error (broker or People API unreachable)
 *   14 account-provisioning (agnt_ account is being auto-created; retry later)
 *   16 directory-sharing-disabled — the Workspace admin console setting
 *      "External Directory Sharing" is restrictive. Distinct from every other
 *      code because NO code change fixes it: it is an admin action, and
 *      collapsing it into a generic 403 is what made this issue expensive to
 *      diagnose the first time.
 *   17 insufficient-scope — the token genuinely lacks directory.readonly.
 */

'use strict';

const WS = require('/opt/psd-skills/psd-workspace/common.js');
const lib = require('./lib');

const USAGE = `psd-directory — resolve a district email or Chat user id to a real person

Usage:
  run.js --user <owner@psd401.net> --email <address>
  run.js --user <owner@psd401.net> --chat-id <users/{id} | {id}>

Options:
  --user      Required. The owner whose agnt_ account brokers the lookup.
  --email     Resolve an email address to a directory person.
  --chat-id   Resolve a Chat users/{id} (or bare numeric id) to a person.
  --no-cache  Bypass the lookup cache for this call.
  --help      Show this message.

Exactly one of --email / --chat-id is required.`;

function fail(message, code = 1) {
  process.stderr.write(`psd-directory: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const args = WS.parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const userEmail = args.user;
  if (!userEmail || userEmail === true) fail('--user is required');
  WS.validateUserEmail(userEmail);

  const wantEmail = typeof args.email === 'string' ? args.email : null;
  const wantChatId = typeof args.chat_id === 'string' ? args.chat_id : null;
  if (!wantEmail && !wantChatId) fail('one of --email or --chat-id is required');
  if (wantEmail && wantChatId) fail('--email and --chat-id are mutually exclusive');

  // Agent-slot token via the DWD broker (directory.readonly already granted).
  let broker;
  try {
    broker = await WS.fetchBrokerToken(userEmail);
  } catch (err) {
    fail(`could not mint an agent token: ${err.message}`, 12);
  }
  if (broker && broker.notProvisioned) {
    emit({ status: 'account-provisioning', ownerEmail: userEmail });
    return 14;
  }

  const opts = { noCache: args.no_cache === true };
  try {
    const result = wantEmail
      ? await lib.resolveEmail(wantEmail, broker.accessToken, opts)
      : await lib.resolvePersonId(wantChatId, broker.accessToken, opts);
    emit({ cached: false, ...result });
    return 0;
  } catch (err) {
    if (err instanceof lib.DirectoryError) {
      switch (err.code) {
        case 'DIRECTORY_SHARING_DISABLED':
          fail(
            'the Workspace directory is not shared with API callers. An admin must set ' +
              'Directory > Directory settings > Sharing settings > External Directory Sharing to ' +
              '"Organization data and authenticated user basic profile fields". ' +
              `(Google said: ${err.message})`,
            16
          );
          break;
        case 'INSUFFICIENT_SCOPE':
          fail(`the agent token lacks directory.readonly: ${err.message}`, 17);
          break;
        case 'TRANSPORT':
          fail(err.message, 12);
          break;
        case 'INVALID_INPUT':
          fail(err.message, 1);
          break;
        default:
          fail(`directory lookup failed: ${err.message}`, 2);
      }
    }
    fail(`directory lookup failed: ${err.message}`, 2);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => fail(`unexpected error: ${err && err.message}`, 2));
