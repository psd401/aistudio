#!/usr/bin/env node
'use strict';

// Validate Red Rover credentials and return organization info (orgId + name).
// Usage: node get_organization.js --user <email>
// Read-only.

const { parseArgs, requireUser, getCredentials, getOrganization, emit, fail } = require('./lib/api.js');

(async () => {
  const args = parseArgs(process.argv);
  const user = requireUser(args);
  try {
    const creds = getCredentials(user);
    const org = await getOrganization(creds);
    // Intentionally omit apiKey — downstream commands fetch it internally,
    // and including it here risks accidental credential exposure in chat.
    emit({ orgId: org.orgId, name: org.raw?.name || null });
  } catch (err) {
    fail(err.message, 'redrover_org_failed');
  }
})();
