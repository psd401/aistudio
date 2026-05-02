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

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, `/tickets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
