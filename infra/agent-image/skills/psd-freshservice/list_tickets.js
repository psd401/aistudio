#!/usr/bin/env node
/**
 * list_tickets.js — list Freshservice tickets with optional filters.
 *
 * Usage:
 *   node list_tickets.js --user <email> [--options '<json>']
 *
 * Options JSON: { workspace_id, filter, include, per_page, page,
 *                 order_type, updated_since }.
 * filter: new_and_my_open | watching | spam | deleted | archived
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, parseJsonArg } =
  require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: list_tickets.js --user <email> [--options \'{"workspace_id":2,"filter":"new_and_my_open"}\']');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const apiKey = getApiKey(userEmail);
  const opts = args.options ? parseJsonArg(args.options, '--options') : {};

  const params = new URLSearchParams();
  if (opts.workspace_id !== undefined) params.append('workspace_id', String(opts.workspace_id));
  if (opts.filter) params.append('filter', String(opts.filter));
  if (opts.include) params.append('include', String(opts.include));
  params.append('per_page', String(opts.per_page || 30));
  if (opts.page) params.append('page', String(opts.page));
  if (opts.order_type) params.append('order_type', String(opts.order_type));
  if (opts.updated_since) params.append('updated_since', String(opts.updated_since));

  const result = await fsFetch(apiKey, `/tickets?${params.toString()}`);
  if (!result.__ok) fail(result.error, 'upstream_error');

  const tickets = (result.data.tickets || []).map((t) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    requester_id: t.requester_id,
    responder_id: t.responder_id,
    group_id: t.group_id,
    workspace_id: t.workspace_id,
    created_at: t.created_at,
    updated_at: t.updated_at,
    due_by: t.due_by,
  }));

  emit({ count: tickets.length, tickets });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
