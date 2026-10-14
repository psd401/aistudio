#!/usr/bin/env node
/**
 * Mint a one-time secure entry link for a user-supplied credential (#1887).
 *
 * This is the ONLY correct way to obtain a secret from a user. Never ask them
 * to paste an API key, token, or password into chat: the value would land in
 * the conversation transcript unredacted. Send them this link instead — they
 * type the value into a password field on an AI Studio page, and it goes
 * straight to encrypted storage without passing through the model.
 *
 * Usage: node request_entry.js --name <credential-name> [--label <what it is>]
 *
 * Emits { url, credentialName, expiresInMinutes, chatInstructions }.
 * Paste `url` on a line by itself — no markdown, no parens, no trailing
 * period — exactly like a Workspace consent link.
 */

'use strict';

const {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  validateCredentialName,
  requestConsentLink,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: request_entry.js --name <credential-name> [--label <what it is>]');
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  validateCredentialName(args.name);
  if (typeof args.value === 'string') {
    fail('--value is not accepted; the user types the secret into the entry page');
  }

  try {
    const result = await requestConsentLink({
      kind: 'credential_entry',
      name: args.name,
    });
    if (!result || typeof result.url !== 'string') {
      fail('Credential broker returned no entry link');
    }
    emit({
      url: result.url,
      credentialName: args.name,
      expiresInMinutes: 15,
      label: typeof args.label === 'string' ? args.label : args.name,
      chatInstructions: [
        'Send the url on a line by itself — no markdown, no parens, no trailing period.',
        'Tell the user the link works once and expires in 15 minutes.',
        'Do NOT ask them to paste the value into chat, and do not ask them to read it back.',
        'After they confirm they saved it, retry the original command.',
      ],
    });
  } catch (error) {
    fail(`Failed to mint credential entry link: ${error.message}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
