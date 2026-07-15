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
 *     OAuth on the human user's identity (hagelk@psd401.net), scopes
 *     (gmail.modify, calendar, tasks, drive.file). gmail.modify covers
 *     read + draft + archive/label + (technically) send — sending is
 *     blocked by the skill's regex gate, not by the OAuth scope. Use for
 *     reading/writing the human's own data.
 *
 *   --scope agent →
 *     The agent account (agnt_hagelk@psd401.net), broad scopes. As of #1232
 *     there is NO consent flow for this slot: a short-lived access token is
 *     minted on demand by the DWD broker (POST /api/agent/workspace-token).
 *     If the agnt_ account isn't created yet, the skill emits
 *     status:"account-provisioning" (exit 14) — the router auto-provisions it
 *     and the user simply retries later; nothing to click.
 *
 * Phase 1 hard gates: Send mail, delete operations, and modification of
 * user-created content are blocked at the skill layer regardless of scope —
 * the model cannot bypass these by phrasing the gws command differently.
 * Additionally, file creation (Drive/Docs/Sheets/Slides) is blocked on the
 * USER slot: files created there are owned by the user's account
 * (impersonation). Create with --scope agent and share explicitly.
 *
 * Flow:
 *   1. Phase 1 gate check on --command (forbidden ops → exit 13)
 *   2. Marker injection on --command (calendar create, draft create, task
 *      create, drive create get markers automatically)
 *   3. Resolve an access token for the slot:
 *      - agent slot → mint a DWD token from the broker
 *        (account-not-provisioned → emit account-provisioning, exit 14)
 *      - user slot  → per-user refresh token (not found → needs-auth exit 10;
 *        invalid_grant → token-revoked exit 11) + shared OAuth client refresh
 *   4. Exec `gws <command>` with the resolved access token
 *   5. Pass through stdout/stderr and exit code
 *
 * Exit codes:
 *   0  success
 *   1  usage / config error
 *   2  gws exec failure
 *   10 needs-auth (user slot, no token)
 *   11 token-revoked (user slot, invalid_grant from Google)
 *   12 transport error (broker/network failure)
 *   13 phase1-forbidden (Phase 1 hard gate refused the command)
 *   14 account-provisioning (agent slot; agnt_ account being auto-created)
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
  fetchBrokerToken,
  execGws,
  enforcePhase1Gates,
  injectMarkers,
  resolvePayloadFiles,
  extractJsonArg,
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

  // 0. Payload files (#1138 follow-up) — `--json-file` / `--body-file`
  // deliver arbitrary text (quotes, apostrophes, newlines) that cannot ride
  // inside the --command string (splitCommand has no escape syntax). The
  // gates and marker injection below run against `syntheticCommand`, which
  // has the REAL file content inlined, so neither protection is blinded by
  // the indirection; execution uses the placeholder form + payload map so
  // tokenization never touches the content.
  const resolvedPayloads = resolvePayloadFiles(command);
  let guardedCommand = resolvedPayloads
    ? resolvedPayloads.syntheticCommand
    : command;

  // 1. Phase 1 hard gates — refused at the skill layer regardless of scope
  // or how the model phrases the request. The scope+ownerEmail context lets
  // the gate apply a narrow exception for share-to-caller handoffs (the
  // agent shares files it owns back to the conversation owner, read-only).
  const gateCheck = enforcePhase1Gates(guardedCommand, { scope, ownerEmail });
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
  // every artifact the agent touches is auditable as agent-touched. Runs on
  // the synthetic (payload-inlined) form so file-based JSON payloads get
  // markers too; the mutated JSON is pulled back into the payload map below.
  guardedCommand = injectMarkers(guardedCommand);
  if (resolvedPayloads) {
    const jsonPlaceholder = '@@PSD_PAYLOAD_JSON@@';
    if (resolvedPayloads.payloads[jsonPlaceholder]) {
      const mutatedJson = extractJsonArg(guardedCommand);
      if (mutatedJson) {
        resolvedPayloads.payloads[jsonPlaceholder] = mutatedJson;
      }
    }
    command = resolvedPayloads.execCommand;
  } else {
    command = guardedCommand;
  }

  // 3. Resolve an access token for the requested slot.
  let accessToken;

  if (scope === 'agent_account') {
    // AGENT slot (#1232): no consent, no stored refresh token. Mint a
    // short-lived DWD access token from the broker on demand. If the agnt_
    // account doesn't exist yet, the router auto-provisions it (#1233) — tell
    // the user to wait, with NO consent URL to click.
    let brokered;
    try {
      brokered = await fetchBrokerToken(ownerEmail);
    } catch (err) {
      fail(`Unable to fetch agent workspace token: ${err.message}`, 12);
    }
    if (brokered.notProvisioned) {
      emit({
        status: 'account-provisioning',
        kind: 'agent_account',
        message:
          'Your agent Workspace account is being set up automatically — no action ' +
          'needed. Try again in about 30 minutes. (There is nothing to click for this.)',
      });
      process.exit(14);
    }
    if (!brokered.accessToken) {
      fail('Broker returned no access token for the agent slot');
    }
    accessToken = brokered.accessToken;
  } else {
    // USER slot: unchanged — per-user refresh token + consent flow.
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
        message:
          'Paste consent_chat_hyperlink on its own line, no surrounding markdown. Then on a separate line: "Click the link to grant me read access to your inbox and to-dos."',
      });
      process.exit(10);
    }

    // Shared OAuth client
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

    // Exchange refresh → access
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
    accessToken = access.access_token;
  }

  // Exec gws with the (possibly marker-injected) command. Payload-file
  // contents are substituted as single argv tokens after tokenization.
  const code = execGws(
    command,
    accessToken,
    resolvedPayloads ? resolvedPayloads.payloads : undefined
  );
  process.exit(code);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
