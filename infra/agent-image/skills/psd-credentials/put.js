#!/usr/bin/env node
/**
 * put.js — credentials.put
 * Usage: node put.js --user <email> --name <credential-name> --value <secret-value>
 *
 * Writes a per-user credential to AWS Secrets Manager at
 * psd-agent-creds/{env}/user/{email}/{name}. Skills can only write to
 * the calling user's path. Shared secrets must be provisioned by an
 * admin out of band.
 *
 * Minimal validation on value contents: rejects excessively long values
 * (>4096 chars), common template placeholders, and obviously non-key
 * patterns. The agent prompts the user to paste a real key.
 * Logs to psd_agent_credentials_audit (name + user email, never value).
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  putUserCredential,
  logCredentialPut,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: put.js --user <email> --name <credential-name> --value <value>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.name) {
    fail('--name is required (credential name to store)');
  }
  if (!args.value || args.value === true) {
    fail('--value is required (the secret value to store)');
  }
  // Secrets Manager accepts up to 65 KB, but no real-world API key exceeds
  // 4 KB. Cap early to prevent accidental storage of large blobs (e.g. an
  // agent-generated multi-KB response pasted into --value by mistake).
  if (args.value.length > 4096) {
    fail('--value exceeds 4096 characters — API keys should not be this long', 'bad_args');
  }
  // Guard against the agent running the storeCommand template verbatim without
  // substituting the placeholder. A model could produce many placeholder
  // variants: "<paste the key here>", "<your-api-key>", "YOUR_API_KEY_HERE",
  // "<API_KEY>", etc. We catch these with three heuristics:
  // 1. Exact match for our template placeholder (case-insensitive)
  // 2. Values that are entirely angle-bracket wrapped (e.g. <anything>)
  // 3. Values shorter than 8 chars (no real API key is this short)
  const trimmed = args.value.trim();
  if (trimmed.toLowerCase() === '<paste the key here>') {
    fail('--value contains the template placeholder — replace with the actual secret before storing', 'bad_args');
  }
  if (/^<[^>]+>$/.test(trimmed)) {
    fail('--value looks like a placeholder (angle-bracket wrapped) — replace with the actual secret', 'bad_args');
  }
  if (trimmed.length < 8) {
    fail('--value is too short (< 8 characters) — API keys are longer than this', 'bad_args');
  }

  try {
    const result = await putUserCredential(args.name, args.value, args.user);

    // logCredentialPut handles errors internally (logs and swallows) so no
    // outer .catch() is needed — it would never fire.
    await logCredentialPut(args.name, args.user, result.action);

    emit({
      name: result.name,
      scope: result.scope,
      action: result.action,
      message: `Credential "${result.name}" ${result.action} for ${args.user}.`,
    });
  } catch (err) {
    fail(`Failed to store credential: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
