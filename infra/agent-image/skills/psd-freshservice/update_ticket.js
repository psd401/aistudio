#!/usr/bin/env node
/**
 * update_ticket.js — update an existing ticket.
 *
 * Usage:
 *   node update_ticket.js --user <email> --id <ticket_id> --data '<json>'
 *
 * Updatable: status, priority, responder_id, group_id, subject,
 * description, custom_fields. Status 2=Open 3=Pending 4=Resolved
 * 5=Closed. Priority 1=Low 2=Medium 3=High 4=Urgent.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, requireTicketId, parseJsonArg } =
  require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: update_ticket.js --user <email> --id <ticket_id> --data \'{...}\'');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const id = requireTicketId(args);
  const data = parseJsonArg(args.data, '--data');

  // Allowlist of Freshservice ticket fields the agent may update. Mirrors the
  // ALLOWED_FIELDS set in create_ticket.js — prevents the agent from sending
  // privileged fields (e.g. source, type, internal metadata) that Freshservice
  // accepts but the agent should not control. custom_fields is included because
  // Freshservice treats it as an opaque JSON object scoped to the ticket.
  const ALLOWED_FIELDS = new Set([
    'subject', 'description', 'status', 'priority',
    'group_id', 'responder_id', 'cc_emails', 'tags',
    'category', 'sub_category', 'item_category', 'due_by', 'fr_due_by',
    'urgency', 'impact', 'custom_fields',
  ]);
  const filtered = Object.create(null);
  for (const key of Object.keys(data)) {
    if (ALLOWED_FIELDS.has(key)) {
      filtered[key] = data[key];
    }
  }

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, `/tickets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(filtered),
  });
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
