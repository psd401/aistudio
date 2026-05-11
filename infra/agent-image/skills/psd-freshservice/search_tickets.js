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
  // Default to workspace 2 (Technology) — consistent with daily/weekly summary
  // scripts. Freshservice's workspace_id=0 behavior is undocumented.
  const workspaceId = args.workspace_id ? Number(args.workspace_id) : 2;
  if (isNaN(workspaceId)) fail('--workspace-id must be a number', 'bad_args');

  const apiKey = getApiKey(userEmail);
  // The query string is passed through to Freshservice's filter API as-is
  // (after URL-encoding). This is intentional — search_tickets is a power-user
  // tool that exposes the full Freshservice filter syntax (field:value AND/OR
  // field:value). Freshservice enforces its own access controls on the
  // caller's API key, so this does not expand the user's data access beyond
  // what their key already permits.
  const url = `/tickets/filter?query="${encodeURIComponent(query)}"&workspace_id=${workspaceId}`;
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
