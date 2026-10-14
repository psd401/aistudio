'use strict';
// Regression test for the first-time-setup prompt (issue #1887).
//
// promptForKey used to tell the agent to ask the user to paste their personal
// API key into chat, and handed it a `put.js --value %%VALUE%%` command to run
// with the pasted string. About 15 staff did exactly that between August and
// October 2026, so their keys are now in `agent_message_content.content_text`
// unredacted. This test pins the replacement: mint a one-time entry link and
// never solicit a paste.
//
// promptForKey calls process.exit(2), so it runs in a child process here.
//
// Run: node --test   (from infra/agent-image/skills/psd-freshservice/)

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function runPromptForKey() {
  const apiPath = path.join(__dirname, 'api.js');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(apiPath)}).promptForKey('someone@psd401.net', 'credential not provisioned')`,
    ],
    { encoding: 'utf8' }
  );
  return result;
}

test('the missing-key prompt exits 2 with a parseable payload', () => {
  const result = runPromptForKey();
  assert.strictEqual(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.error, 'freshservice_key_missing');
  assert.strictEqual(payload.user, 'someone@psd401.net');
});

test('the prompt sends a one-time entry link instead of asking for a paste', () => {
  const payload = JSON.parse(runPromptForKey().stdout);

  // The entry-link command is the whole point: name + label, no value.
  assert.ok(payload.entryLinkCommand, 'entryLinkCommand must be present');
  assert.strictEqual(payload.entryLinkCommand.cmd, 'node');
  const args = payload.entryLinkCommand.args;
  assert.ok(
    args.some((arg) => arg.endsWith('psd-credentials/request_entry.js')),
    `expected request_entry.js in ${JSON.stringify(args)}`
  );
  assert.ok(args.includes('--name'));
  assert.ok(args.includes('freshservice_api_key'));
  assert.ok(
    !args.includes('--value'),
    'the agent must never be handed a --value slot to splice a user secret into'
  );
});

test('the prompt no longer offers a put.js store command or a paste marker', () => {
  const raw = runPromptForKey().stdout;
  const payload = JSON.parse(raw);

  assert.strictEqual(
    payload.storeCommand,
    undefined,
    'storeCommand reintroduces the paste-then-store flow'
  );
  assert.ok(!raw.includes('%%VALUE%%'), 'the substitution marker must be gone');
  // put.js may be NAMED, but only to forbid it: routing a user-pasted key
  // through `--value` copies the plaintext into the agent's own tool-call
  // record, which is the leak this issue exists to close.
  assert.ok(
    !payload.instructions.some((line) => line.includes('put.js')),
    'the actionable instructions must not route a user secret through put.js'
  );
  assert.match(payload.doNotAskForPaste, /do NOT\s+store it with psd-credentials put\.js/);
  assert.match(payload.doNotAskForPaste, /regenerated at Freshservice/);
});

test('no instruction asks the user to paste the key into chat', () => {
  const payload = JSON.parse(runPromptForKey().stdout);
  const instructions = payload.instructions.join(' ');

  // Directing the paste at the entry PAGE is the fix; directing it at the
  // agent is the bug. Pin the phrasings that mean the latter.
  for (const forbidden of [
    'paste it back',
    'paste it to me',
    'paste it here',
    'paste the key in chat',
    'paste your key',
    'send me the key',
    'type it here',
    'read it back',
  ]) {
    assert.ok(
      !instructions.toLowerCase().includes(forbidden),
      `instructions still solicit a chat paste ("${forbidden}"): ${instructions}`
    );
  }
  // ...and pin the steer that replaces it.
  assert.match(instructions, /paste it into that page \(not into this chat\)/i);
  assert.match(instructions, /entryLinkCommand/);
  assert.match(instructions, /line by itself/);
  assert.match(instructions, /15 minutes/);
  // And the standing rule travels with the payload.
  assert.match(payload.doNotAskForPaste, /[Nn]ever ask the user to paste/);
});
