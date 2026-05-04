#!/usr/bin/env node
/**
 * get_agent.js — look up a Freshservice agent by email.
 *
 * Usage:
 *   node get_agent.js --user <caller-email> [--email <agent-email>]
 *
 * If --email is omitted, looks up the caller's own agent record.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch } = require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_agent.js --user <caller-email> [--email <agent-email>]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const lookupEmail = (args.email && args.email !== true) ? args.email : userEmail;

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, `/agents?email=${encodeURIComponent(lookupEmail)}`);
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
