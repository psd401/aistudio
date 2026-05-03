#!/usr/bin/env node
/**
 * add_note.js — add a note to a ticket. Defaults to private note.
 *
 * Usage:
 *   node add_note.js --user <email> --id <ticket_id> --data '<json>'
 *
 * JSON: { body, private?: true, notify_emails?: ["..."] }.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, requireTicketId, parseJsonArg } =
  require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: add_note.js --user <email> --id <ticket_id> --data \'{"body":"..."}\'');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const id = requireTicketId(args);
  const data = parseJsonArg(args.data, '--data');
  if (!data.body) fail('data.body is required', 'bad_args');
  // Avoid mutating the parsed JSON object in-place — spread a new object
  // with `private` defaulting to true (overridable by the caller's JSON).
  const payload = { private: true, ...data };

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, `/tickets/${id}/notes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
