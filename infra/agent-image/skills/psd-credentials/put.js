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
 * Caller-trusted on value contents — no length or format validation
 * (per plan decision; agent prompts the user to paste a real key).
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
  // substituting the placeholder. Storing the literal string wastes a Secrets
  // Manager secret and silently "succeeds" with a non-functional credential.
  // Case-insensitive to catch variations like "<paste the key here>" or
  // "<Paste The Key Here>" that a user or model might produce.
  if (args.value.trim().toLowerCase() === '<paste the key here>') {
    fail('--value contains the template placeholder — replace with the actual secret before storing', 'bad_args');
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
