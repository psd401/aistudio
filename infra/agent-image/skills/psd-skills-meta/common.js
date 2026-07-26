/**
 * Owner-bound skill-catalog broker client.
 *
 * The model runtime has no S3, database, or Lambda permissions. Search, load,
 * and author requests go through AI Studio, which derives the owner from the
 * signed invocation context.
 */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

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
  for (const name of ['user', 'owner_email', 'user_email', 'user_id']) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      fail(`--${name.replace(/_/g, '-')} is not accepted; identity comes from the signed invocation`);
    }
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const SAFE_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
function validateSafeName(name, label) {
  if (typeof name !== 'string' || !SAFE_NAME_RE.test(name)) {
    fail(`Invalid ${label}: "${name}"`);
  }
}

async function skillBroker(operation, body) {
  try {
    return await requestAgentBroker('/api/agent/skills', {
      operation,
      ...body,
    });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

module.exports = {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  validateSafeName,
  skillBroker,
};
