#!/usr/bin/env node
/**
 * list_agents.js — list all active Freshservice agents.
 *
 * Usage:
 *   node list_agents.js --user <email> [--query <name-or-email-substring>]
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch } = require('./lib/api');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: list_agents.js --user <email> [--query <name-substring>]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const query = args.query && args.query !== true ? String(args.query).toLowerCase() : null;

  const apiKey = getApiKey(userEmail);
  let all = [];
  let page = 1;
  // Cap pages defensively — Freshservice tenants typically have a few hundred agents.
  while (page <= 50) {
    const result = await fsFetch(apiKey, `/agents?per_page=100&page=${page}`);
    if (!result.__ok) fail(result.error, 'upstream_error');
    const batch = result.data.agents || [];
    all = all.concat(batch);
    if (batch.length < 100) break;
    page += 1;
  }

  let agents = all
    .filter((a) => a.active)
    .map((a) => ({
      id: a.id,
      name: `${a.first_name} ${a.last_name}`,
      first_name: a.first_name,
      last_name: a.last_name,
      email: a.email,
      job_title: a.job_title,
    }));

  if (query) {
    agents = agents.filter((a) =>
      (a.first_name || '').toLowerCase().includes(query) ||
      (a.last_name || '').toLowerCase().includes(query) ||
      (a.email || '').toLowerCase().includes(query));
  }
  agents.sort((a, b) => (a.first_name || '').localeCompare(b.first_name || ''));
  emit({ count: agents.length, agents });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
