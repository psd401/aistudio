#!/usr/bin/env node
/**
 * run.js — psd-workspace skill entrypoint (#912)
 *
 * Usage:
 *   node run.js --user <email> --command "<gws subcommand + args>"
 *
 * Flow:
 *   1. Fetch per-user refresh-token record from Secrets Manager
 *      - Not found → mint consent URL, emit needs-auth (exit 10)
 *   2. Load shared OAuth client credentials
 *   3. Exchange refresh token for access token
 *      - invalid_grant → mint consent URL, emit token-revoked (exit 11)
 *   4. Exec `gws <command>` with GOOGLE_ACCESS_TOKEN env var
 *   5. Pass through stdout/stderr and exit code
 *
 * Exit codes:
 *   0  success
 *   1  usage / config error
 *   2  gws exec failure
 *   10 needs-auth (no token)
 *   11 token-revoked (invalid_grant from Google)
 *   12 missing-scope (reserved; gws does not currently surface this — left
 *      here so the SKILL.md contract is honored when it starts)
 */

'use strict';

const {
  fail,
  emit,
  parseArgs,
  validateUserEmail,
  getSecretJson,
  getUserWorkspaceToken,
  refreshAccessToken,
  mintConsentUrl,
  execGws,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: run.js --user <email> --command "<gws subcommand + args>"\n'
    );
    process.exit(0);
  }

  validateUserEmail(args.user);
  if (!args.command || args.command === true) {
    fail('--command is required (e.g. --command "gmail.list --query is:unread")');
  }

  const ownerEmail = args.user;

  // 1. Per-user refresh-token record
  const tokenRecord = await getUserWorkspaceToken(ownerEmail);
  if (!tokenRecord || !tokenRecord.refresh_token) {
    let consentUrl;
    try {
      consentUrl = await mintConsentUrl(ownerEmail);
    } catch (err) {
      fail(`Unable to mint consent URL: ${err.message}`);
    }
    emit({
      status: 'needs-auth',
      consent_url: consentUrl,
      message:
        'Workspace not connected yet. Click the link above to authorize your agent account.',
    });
    process.exit(10);
  }

  // 2. Shared OAuth client
  let clientCreds;
  try {
    clientCreds = await getSecretJson(
      process.env.GOOGLE_OAUTH_CLIENT_SECRET_ID
        || `psd-agent/${process.env.ENVIRONMENT || 'dev'}/google-oauth-client`
    );
  } catch (err) {
    fail(`Unable to read Google OAuth client secret: ${err.message}`);
  }
  const { client_id, client_secret } = clientCreds;
  if (!client_id || !client_secret) {
    fail('Google OAuth client secret missing client_id or client_secret');
  }

  // 3. Exchange refresh → access
  let access;
  try {
    access = await refreshAccessToken(
      tokenRecord.refresh_token,
      client_id,
      client_secret
    );
  } catch (err) {
    if (err.code === 'invalid_grant') {
      let consentUrl;
      try {
        consentUrl = await mintConsentUrl(ownerEmail);
      } catch (e) {
        fail(`Token revoked but consent-link mint failed: ${e.message}`);
      }
      emit({
        status: 'token-revoked',
        consent_url: consentUrl,
        message:
          'Your agent lost Workspace access (likely revoked in Google). Click the link above to re-authorize.',
      });
      process.exit(11);
    }
    fail(`Token refresh failed: ${err.message}`);
  }

  if (!access || !access.access_token) {
    fail('Token refresh returned no access_token');
  }

  // 4. Exec gws
  const code = execGws(args.command, access.access_token);
  process.exit(code);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
