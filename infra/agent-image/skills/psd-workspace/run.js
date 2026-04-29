#!/usr/bin/env node
/**
 * run.js — psd-workspace skill entrypoint (#912 + Phase 1)
 *
 * Usage:
 *   node run.js --user <email> --command "<gws subcommand + args>" [--scope user|agent]
 *
 * The --scope flag (added 2026-04-26 for Phase 1) selects which OAuth slot
 * the skill uses to authenticate the gws call:
 *
 *   --scope user (default for Phase 1) →
 *     OAuth on the human user's identity (hagelk@psd401.net), narrow scopes
 *     (gmail.readonly, gmail.compose, calendar, tasks, drive.file). Use for
 *     reading/writing the human's own data.
 *
 *   --scope agent →
 *     OAuth on the agent account (agnt_hagelk@psd401.net), broad scopes.
 *     Use for actions taken AS the agent (drafts the agent owns, agent's own
 *     calendar/drive, future agent-as-itself sends).
 *
 * Phase 1 hard gates: Send mail, delete operations, and modification of
 * user-created content are blocked at the skill layer regardless of scope —
 * the model cannot bypass these by phrasing the gws command differently.
 *
 * Flow:
 *   1. Phase 1 gate check on --command (forbidden ops → exit 13)
 *   2. Marker injection on --command (calendar create, draft create, task
 *      create, drive create get markers automatically)
 *   3. Fetch per-user refresh-token record for the requested slot
 *      - Not found → mint consent URL, emit needs-auth (exit 10)
 *   4. Load shared OAuth client credentials
 *   5. Exchange refresh token for access token
 *      - invalid_grant → mint consent URL, emit token-revoked (exit 11)
 *   6. Exec `gws <command>` with GOOGLE_WORKSPACE_CLI_TOKEN env var
 *   7. Pass through stdout/stderr and exit code
 *
 * Exit codes:
 *   0  success
 *   1  usage / config error
 *   2  gws exec failure
 *   10 needs-auth (no token)
 *   11 token-revoked (invalid_grant from Google)
 *   12 missing-scope (reserved)
 *   13 phase1-forbidden (Phase 1 hard gate refused the command)
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
  enforcePhase1Gates,
  injectMarkers,
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

  // Resolve scope. Default for Phase 1 is 'user' — the agent acts on the
  // human user's own data. Pass --scope agent to act as the agent identity
  // (mostly for sending/owning artifacts the agent itself creates).
  const scope = args.scope === 'agent' ? 'agent_account'
    : args.scope === 'user' || args.scope === undefined ? 'user_account'
    : (() => { fail('--scope must be "user" or "agent"'); return null })();

  const ownerEmail = args.user;
  let command = args.command;

  // 1. Phase 1 hard gates — refused at the skill layer regardless of scope
  // or how the model phrases the request.
  const gateCheck = enforcePhase1Gates(command);
  if (!gateCheck.allowed) {
    emit({
      status: 'phase1-forbidden',
      reason: gateCheck.reason,
      message:
        `Phase 1 forbids this operation: ${gateCheck.reason}. ` +
        `If the user explicitly approved, route via the appropriate ` +
        `confirmation flow rather than calling this skill directly.`,
    });
    process.exit(13);
  }

  // 2. Marker injection — calendar/drafts/tasks/drive get auto-markers so
  // every artifact the agent touches is auditable as agent-touched.
  command = injectMarkers(command);

  // 3. Per-user refresh-token record for the requested slot
  const tokenRecord = await getUserWorkspaceToken(ownerEmail, scope);
  if (!tokenRecord || !tokenRecord.refresh_token) {
    let consentUrl;
    try {
      consentUrl = await mintConsentUrl(ownerEmail, scope);
    } catch (err) {
      fail(`Unable to mint consent URL: ${err.message}`);
    }
    emit({
      status: 'needs-auth',
      consent_url: consentUrl,
      // Pre-formatted Google Chat hyperlink. Chat's <url|label> syntax renders
      // as a clickable link without relying on auto-link of a bare URL — which
      // can mangle JWT signature chars when adjacent to markdown punctuation.
      // The agent should paste this exactly, on its own line.
      consent_chat_hyperlink: `<${consentUrl}|Authorize Google Workspace>`,
      kind: scope,
      message: scope === 'user_account'
        ? 'Paste consent_chat_hyperlink on its own line, no surrounding markdown. Then on a separate line: "Click the link to grant me read access to your inbox and to-dos."'
        : 'Paste consent_chat_hyperlink on its own line, no surrounding markdown. Then on a separate line: "Click the link to authorize my agent account."',
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
        consentUrl = await mintConsentUrl(ownerEmail, scope);
      } catch (e) {
        fail(`Token revoked but consent-link mint failed: ${e.message}`);
      }
      emit({
        status: 'token-revoked',
        consent_url: consentUrl,
        consent_chat_hyperlink: `<${consentUrl}|Re-authorize Google Workspace>`,
        kind: scope,
        message:
          'Paste consent_chat_hyperlink on its own line, no surrounding markdown. Then on a separate line: "Workspace access was revoked — click the link to re-authorize."',
      });
      process.exit(11);
    }
    fail(`Token refresh failed: ${err.message}`);
  }

  if (!access || !access.access_token) {
    fail('Token refresh returned no access_token');
  }

  // Exec gws with the (possibly marker-injected) command
  const code = execGws(command, access.access_token);
  process.exit(code);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
