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
 *     (gmail.modify, calendar, tasks, drive.file, drive.readonly,
 *     drive.metadata). gmail.modify covers read + draft + archive/label +
 *     (technically) send — sending is blocked by the skill's regex gate, not
 *     by the OAuth scope. drive.readonly + drive.metadata (#1305) let the
 *     agent READ and ORGANIZE the user's Drive: list/get/export anything,
 *     rename/move/star, and create FOLDERS. Creating a non-folder item,
 *     writing file content, trashing and deleting all remain impossible —
 *     see the Phase 1 gate notes below. Use for reading/writing the human's
 *     own data.
 *
 *   --scope agent →
 *     The agent account (agnt_hagelk@psd401.net), broad scopes. The trusted
 *     operation broker mints and uses a short-lived credential without
 *     returning it to this process. If the agnt_ account isn't created yet, it emits
 *     status:"account-provisioning" (exit 14) — the router auto-provisions it
 *     and the user simply retries later; nothing to click.
 *
 * Phase 1 hard gates: Send mail, delete operations, and modification of
 * user-created content are blocked here and independently revalidated by the
 * trusted web broker regardless of scope.
 * Additionally, file creation (Drive/Docs/Sheets/Slides) is blocked on the
 * USER slot: files created there are owned by the user's account
 * (impersonation). Create with --scope agent; permission changes require the
 * server-recorded provenance flow.
 *
 * Flow:
 *   1. Phase 1 gate check on --command (forbidden ops → exit 13)
 *   2. Marker injection on --command (calendar create, draft create, task
 *      create, drive create get markers automatically)
 *   3. Send the tokenized command to the trusted web broker.
 *   4. The broker derives the owner from the signed invocation context,
 *      obtains a token outside the model runtime, re-validates the operation,
 *      and executes gws in the web task.
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
 *   15 scope-upgrade-required (user slot; the stored token predates a scope
 *      this command needs — #1305. Distinct from 10/11 so the caller can say
 *      "one more permission" rather than "you never authorized me")
 */

'use strict';

const {
  fail,
  emit,
  parseArgs,
  validateUserEmail,
  splitCommand,
  enforcePhase1Gates,
  injectMarkers,
  resolvePayloadFiles,
  extractJsonArg,
} = require('./common');
const { requestAgentBroker } = require('../_shared/agent-broker');

function resolveScope(scope) {
  if (scope === 'agent') return 'agent_account';
  if (scope === 'user' || scope === undefined) return 'user_account';
  fail('--scope must be "user" or "agent"');
}

function emitForbiddenGate(gateCheck) {
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

function restorePayloadArguments(argv, resolvedPayloads) {
  if (!resolvedPayloads) return argv;
  return argv.map((token) =>
    Object.prototype.hasOwnProperty.call(resolvedPayloads.payloads, token)
      ? resolvedPayloads.payloads[token]
      : token
  );
}

function prepareWorkspaceArguments(command, scope, ownerEmail) {
  const resolvedPayloads = resolvePayloadFiles(command);
  let guardedCommand = resolvedPayloads
    ? resolvedPayloads.syntheticCommand
    : command;
  const gateCheck = enforcePhase1Gates(guardedCommand, { scope, ownerEmail });
  if (!gateCheck.allowed) emitForbiddenGate(gateCheck);

  guardedCommand = injectMarkers(guardedCommand);
  if (!resolvedPayloads) return splitCommand(guardedCommand);

  const jsonPlaceholder = '@@PSD_PAYLOAD_JSON@@';
  if (resolvedPayloads.payloads[jsonPlaceholder]) {
    const mutatedJson = extractJsonArg(guardedCommand);
    if (mutatedJson) resolvedPayloads.payloads[jsonPlaceholder] = mutatedJson;
  }
  return restorePayloadArguments(
    splitCommand(resolvedPayloads.execCommand),
    resolvedPayloads
  );
}

function isWorkspaceAuthError(status) {
  return [
    'needs-auth',
    'token-revoked',
    'scope-upgrade-required',
  ].includes(status);
}

async function emitWorkspaceConsent(response) {
  let consent;
  try {
    consent = await requestAgentBroker('/api/agent/consent-link', {
      kind: 'user_account',
    });
  } catch (consentError) {
    fail(
      `Workspace authorization is required and consent-link creation failed: ${consentError.message}`,
      12
    );
  }
  const revoked = response.status === 'token-revoked';
  const scopeUpgrade = response.status === 'scope-upgrade-required';
  emit({
    status: response.status,
    consent_url: consent.url,
    consent_chat_hyperlink:
      `<${consent.url}|${revoked || scopeUpgrade ? 'Re-authorize' : 'Authorize'} Google Workspace>`,
    kind: 'user_account',
    ...(scopeUpgrade && Array.isArray(response.missingScopes)
      ? { missing_scopes: response.missingScopes }
      : {}),
    message: scopeUpgrade
      ? `I need one more permission to ${response.capability || 'use this Drive feature'} — click the link to grant it. Do not retry until the user confirms.`
      : revoked
        ? 'Workspace access was revoked — click the link to re-authorize.'
        : 'Click the link to authorize Google Workspace, then retry.',
  });
  process.exit(scopeUpgrade ? 15 : revoked ? 11 : 10);
}

async function handleWorkspaceError(err) {
  const response = err.responseBody || {};
  if (response.status === 'account-not-provisioned') {
    emit({
      status: 'account-provisioning',
      kind: 'agent_account',
      message:
        'Your agent Workspace account is being set up automatically. Try again in about 30 minutes.',
    });
    process.exit(14);
  }
  if (isWorkspaceAuthError(response.status)) {
    await emitWorkspaceConsent(response);
  }
  fail(`Workspace broker failed: ${err.message}`, 12);
}

async function executeWorkspace(scope, argv) {
  try {
    const result = await requestAgentBroker('/api/agent/workspace-execute', {
      scope: scope === 'agent_account' ? 'agent' : 'user',
      argv,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (err) {
    await handleWorkspaceError(err);
  }
}

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

  const scope = resolveScope(args.scope);
  const ownerEmail = args.user;
  const argv = prepareWorkspaceArguments(args.command, scope, ownerEmail);
  await executeWorkspace(scope, argv);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
