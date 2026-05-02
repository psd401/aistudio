#!/usr/bin/env node
/**
 * search_tickets.js — search tickets via Freshservice filter query.
 *
 * Usage:
 *   node search_tickets.js --user <email> --query '<query>' [--workspace-id N]
 *
 * Query syntax: field:value AND/OR field:value. Fields include status,
 * priority, agent_id, group_id, created_at, updated_at, responder_id.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch } = require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: search_tickets.js --user <email> --query "status:2 AND priority:3" [--workspace-id 2]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const query = args.query;
  if (!query || query === true) fail('--query is required', 'bad_args');
  const workspaceId = args.workspace_id || '0';

  const apiKey = getApiKey(userEmail);
  const url = `/tickets/filter?query="${encodeURIComponent(query)}"&workspace_id=${encodeURIComponent(workspaceId)}`;
  const result = await fsFetch(apiKey, url);
  if (!result.__ok) fail(result.error, 'upstream_error');

  const tickets = (result.data.tickets || []).map((t) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    workspace_id: t.workspace_id,
    responder_id: t.responder_id,
    created_at: t.created_at,
    updated_at: t.updated_at,
    due_by: t.due_by,
  }));
  emit({ count: tickets.length, tickets });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
