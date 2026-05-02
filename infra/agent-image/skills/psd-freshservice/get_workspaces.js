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

  // Use the /workspaces endpoint to list all accessible workspaces in a
  // single API call instead of probing a hardcoded list of IDs. This is
  // more robust (auto-discovers new workspaces) and more efficient (one
  // call vs. N parallel calls).
  const result = await fsFetch(apiKey, '/workspaces');
  if (!result.__ok) fail(result.error, 'upstream_error');
  const workspaces = (result.data.workspaces || []).map((w) => ({
    id: w.id,
    name: w.name,
    primary: w.primary,
    state: w.state,
  }));
  emit({ workspaces });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
