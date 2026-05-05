#!/usr/bin/env node
'use strict';

// Validate Red Rover credentials and return organization info (orgId + dynamic apiKey).
// Usage: node get_organization.js --user <email>
// Read-only.

const { parseArgs, requireUser, getCredentials, getOrganization, emit, fail } = require('./lib/api.js');

(async () => {
  const args = parseArgs(process.argv);
  const user = requireUser(args);
  try {
    const creds = getCredentials(user);
    const org = await getOrganization(creds);
    emit({ orgId: org.orgId, name: org.raw?.name || null, apiKey: org.apiKey });
  } catch (err) {
    fail(err.message, 'redrover_org_failed');
  }
})();
