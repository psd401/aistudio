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
 * (impersonation). Create with --scope agent and share explicitly.
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

  // 3. Tokenize locally, preserving payload-file contents as one argv value,
  // then delegate to the owner-bound broker. The model runtime receives
  // neither a Google token nor a raw gws binary.
  let argv = splitCommand(command);
  if (resolvedPayloads) {
    argv = argv.map((token) =>
      Object.prototype.hasOwnProperty.call(resolvedPayloads.payloads, token)
        ? resolvedPayloads.payloads[token]
        : token
    );
  }

  try {
    const result = await requestAgentBroker('/api/agent/workspace-execute', {
      scope: scope === 'agent_account' ? 'agent' : 'user',
      argv,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (err) {
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
    if (response.status === 'needs-auth') {
      let consent;
      try {
        consent = await requestAgentBroker('/api/agent/consent-link', {
          kind: 'user_account',
        });
      } catch (consentError) {
        fail(`Workspace authorization is required and consent-link creation failed: ${consentError.message}`, 12);
      }
      emit({
        status: 'needs-auth',
        consent_url: consent.url,
        consent_chat_hyperlink: `<${consent.url}|Authorize Google Workspace>`,
        kind: 'user_account',
        message: 'Click the link to authorize Google Workspace, then retry.',
      });
      process.exit(10);
    }
    fail(`Workspace broker failed: ${err.message}`, 12);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
