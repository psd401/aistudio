#!/usr/bin/env node
/**
 * get_workspaces.js — list workspaces the caller can see (or one by id).
 *
 * Usage:
 *   node get_workspaces.js --user <email> [--id <workspace_id>]
 *
 * Without --id, probes the well-known PSD workspace IDs.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch } = require('./lib/api');

const KNOWN_WORKSPACE_IDS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 13];

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_workspaces.js --user <email> [--id <workspace_id>]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const apiKey = getApiKey(userEmail);

  if (args.id && args.id !== true) {
    const result = await fsFetch(apiKey, `/workspaces/${encodeURIComponent(args.id)}`);
    if (!result.__ok) fail(result.error, 'upstream_error');
    emit(result.data.workspace || result.data);
    return;
  }

  const results = await Promise.all(KNOWN_WORKSPACE_IDS.map(async (id) => {
    const r = await fsFetch(apiKey, `/workspaces/${id}`);
    if (!r.__ok) return null;
    const w = r.data.workspace || r.data;
    return { id: w.id, name: w.name, primary: w.primary, state: w.state };
  }));
  emit({ workspaces: results.filter(Boolean) });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
