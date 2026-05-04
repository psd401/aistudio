#!/usr/bin/env node
/**
 * get_ticket.js — get ticket details by ID.
 *
 * Usage:
 *   node get_ticket.js --user <email> --id <ticket_id> [--include <comma-list>]
 *
 * Include options: conversations, requester, problem, stats, assets,
 * change, related_tickets.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, requireTicketId } = require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_ticket.js --user <email> --id <ticket_id> [--include <list>]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const id = requireTicketId(args);

  const apiKey = getApiKey(userEmail);
  const include = args.include && args.include !== true ? `?include=${encodeURIComponent(args.include)}` : '';
  const result = await fsFetch(apiKey, `/tickets/${id}${include}`);
  if (!result.__ok) fail(result.error, 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
