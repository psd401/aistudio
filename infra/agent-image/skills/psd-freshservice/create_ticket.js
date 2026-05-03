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

  // Allowlist of Freshservice ticket fields the agent may set. Prevents callers
  // from injecting privileged fields (e.g. source, type, internal metadata) that
  // Freshservice may accept but the agent should not control.
  const ALLOWED_FIELDS = new Set([
    'subject', 'description', 'email', 'requester_id', 'status', 'priority',
    'workspace_id', 'group_id', 'responder_id', 'cc_emails', 'tags',
    'category', 'sub_category', 'item_category', 'due_by', 'fr_due_by',
    'urgency', 'impact',
  ]);
  const filtered = Object.create(null);
  for (const key of Object.keys(data)) {
    if (ALLOWED_FIELDS.has(key)) {
      filtered[key] = data[key];
    }
  }
  filtered.status = filtered.status ?? 2;
  filtered.priority = filtered.priority ?? 2;

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, '/tickets', {
    method: 'POST',
    body: JSON.stringify(filtered),
  });
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
