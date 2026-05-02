#!/usr/bin/env node
/**
 * create_ticket.js — create a new Freshservice ticket.
 *
 * Usage:
 *   node create_ticket.js --user <email> --data '<json>'
 *
 * Required JSON fields: subject, description, email (requester) or
 * requester_id. Optional: priority (1-4), status (2 Open, 3 Pending,
 * 4 Resolved, 5 Closed), workspace_id.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, parseJsonArg } =
  require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: create_ticket.js --user <email> --data \'{"subject":"...","description":"...","email":"..."}\'');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const data = parseJsonArg(args.data, '--data');

  if (!data.subject || !data.description || (!data.email && !data.requester_id)) {
    fail('Required fields: subject, description, and email or requester_id', 'bad_args');
  }
  data.status = data.status ?? 2;
  data.priority = data.priority ?? 2;

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, '/tickets', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
