#!/usr/bin/env node
/**
 * get_approvals.js — fetch tickets/changes awaiting the caller's approval.
 *
 * Usage:
 *   node get_approvals.js --user <email> [--status requested|approved|rejected|cancelled]
 *
 * Auto-resolves the caller's Freshservice agent ID via /agents?email=.
 * Polls both ticket and change parents and merges results.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch } = require('./lib/api');

async function resolveAgentId(apiKey, email) {
  const r = await fsFetch(apiKey, `/agents?email=${encodeURIComponent(email)}`);
  if (!r.__ok) return null;
  const agents = r.data.agents || [];
  return agents.length ? agents[0].id : null;
}

async function fetchApprovals(apiKey, agentId, status, parent) {
  const url = `/approvals?approver_id=${agentId}&status=${encodeURIComponent(status)}&parent=${parent}`;
  const r = await fsFetch(apiKey, url);
  if (!r.__ok) return { error: r.error, approvals: [] };
  return {
    approvals: (r.data.approvals || []).map((a) => ({
      id: a.id,
      approval_type: a.approval_type,
      approver_id: a.approver_id,
      status: a.status,
      created_at: a.created_at,
      updated_at: a.updated_at,
      approvable_id: a.approvable_id,
      approvable_type: a.approvable_type,
      delegator: a.delegator,
      latest_remark: a.latest_remark,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_approvals.js --user <email> [--status requested]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const status = args.status && args.status !== true ? String(args.status) : 'requested';

  const apiKey = getApiKey(userEmail);
  const agentId = await resolveAgentId(apiKey, userEmail);
  if (!agentId) {
    fail(`Could not resolve Freshservice agent ID for ${userEmail}`, 'agent_lookup_failed');
  }

  const [ticketRes, changeRes] = await Promise.all([
    fetchApprovals(apiKey, agentId, status, 'ticket'),
    fetchApprovals(apiKey, agentId, status, 'change'),
  ]);

  const approvals = []
    .concat(ticketRes.approvals.map((a) => ({ ...a, parent_type: 'ticket' })))
    .concat(changeRes.approvals.map((a) => ({ ...a, parent_type: 'change' })));

  emit({ count: approvals.length, status, approvals });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
