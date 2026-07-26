/**
 * Shared helpers for the owner-bound credential broker.
 *
 * The model-facing runtime has no Secrets Manager or database credentials.
 * Every operation is sent to the trusted web tier with the opaque, short-lived
 * invocation context issued by the router or scheduler. The web tier verifies
 * that context and derives the owner; no CLI argument can select an identity.
 */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

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

async function requestCredentialOperation(payload) {
  try {
    return await requestAgentBroker('/api/agent/credentials', payload);
  } catch (error) {
    throw new Error(`Credential broker rejected the request: ${error.message}`);
  }
}

module.exports = {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  validateCredentialName,
  requestCredentialOperation,
};
