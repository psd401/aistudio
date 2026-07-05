'use strict';

// Unit tests for the psd-workspace Phase 1 safety gate. Run with: node --test
// (Node's built-in test runner; no extra deps). These prove the gate cannot be
// bypassed by quote insertion (REV-COR-346) or by prefixing the helper verbs
// (REV-COR-350), and that legitimate commands and the narrow share-to-caller
// exception still work.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { enforcePhase1Gates, splitCommand } = require('./common.js');

const userCtx = { scope: 'user_account', ownerEmail: 'caller@psd401.net' };

// ---------------------------------------------------------------------------
// REV-COR-346 — quote-stripping bypass of the send/delete gate
// ---------------------------------------------------------------------------
test('REV-COR-346: quoted send verb is refused (single-quote around verb)', () => {
  assert.equal(enforcePhase1Gates("gmail users messages 'send' --json '{}'", userCtx).allowed, false);
});

test('REV-COR-346: intra-token quote in send verb is refused', () => {
  assert.equal(enforcePhase1Gates("gmail users messages se'nd", userCtx).allowed, false);
});

test('REV-COR-346: double-quoted send verb is refused', () => {
  assert.equal(enforcePhase1Gates('gmail users messages "send"', userCtx).allowed, false);
});

test('REV-COR-346: quoted destructive delete verb is refused', () => {
  assert.equal(enforcePhase1Gates("drive files 'delete' --fileId x", userCtx).allowed, false);
  assert.equal(enforcePhase1Gates('calendar events dele"te" --eventId x', userCtx).allowed, false);
});

test('REV-COR-346: dot-separated invocation style still matches', () => {
  assert.equal(enforcePhase1Gates('gmail.users.messages.send --json {}', userCtx).allowed, false);
});

test('REV-COR-346: positive control — legitimate quoted --query is allowed and tokenizes as expected', () => {
  const cmd = "gmail users messages list --query 'is:unread'";
  assert.equal(enforcePhase1Gates(cmd, userCtx).allowed, true);
  assert.deepEqual(splitCommand(cmd), ['gmail', 'users', 'messages', 'list', '--query', 'is:unread']);
});

// ---------------------------------------------------------------------------
// REV-COR-350 — start-anchored helper patterns bypassed by a leading token
// ---------------------------------------------------------------------------
test('REV-COR-350: +send helper refused when prefixed with the gws program token', () => {
  assert.equal(enforcePhase1Gates('gws gmail +send --to x@y', userCtx).allowed, false);
});

test('REV-COR-350: +send helper refused when a flag precedes the verb', () => {
  assert.equal(enforcePhase1Gates('gmail --to x@y +send', userCtx).allowed, false);
});

test('REV-COR-350: +reply helper refused', () => {
  assert.equal(enforcePhase1Gates('gmail +reply --thread t', userCtx).allowed, false);
  assert.equal(enforcePhase1Gates('gws gmail +reply-all --thread t', userCtx).allowed, false);
  assert.equal(enforcePhase1Gates('gmail --to x +forward', userCtx).allowed, false);
});

test('REV-COR-350: positive control — "reply"/"from:" as a search value is still allowed', () => {
  assert.equal(enforcePhase1Gates("gmail users messages list --query 'from:sender'", userCtx).allowed, true);
  assert.equal(enforcePhase1Gates("gmail users messages list --query 'reply'", userCtx).allowed, true);
});

test('REV-COR-350: "gmail" and a bare send-like word as unquoted query content on an unrelated service is not blocked', () => {
  // Bare (unquoted) query words split into separate tokens by splitCommand, so
  // "gmail" can land several tokens deep as ordinary argument content rather
  // than the gmail service selector (which only ever appears at index 0, or
  // index 1 after a `gws` prefix). detectGmailSendHelper must not treat this
  // as the send/reply/forward helper form (gemini-code-assist review).
  assert.equal(enforcePhase1Gates('drive files list --query gmail send', userCtx).allowed, true);
});

// ---------------------------------------------------------------------------
// Share-to-caller exception must still work and must read the executed --json
// ---------------------------------------------------------------------------
const agentCtx = { scope: 'agent_account', ownerEmail: 'caller@psd401.net' };

test('exception: agent shares its own file to the caller as reader — allowed', () => {
  const cmd = `drive permissions create --fileId f --json '{"type":"user","role":"reader","emailAddress":"caller@psd401.net"}'`;
  assert.equal(enforcePhase1Gates(cmd, agentCtx).allowed, true);
});

test('exception does NOT apply to writer/owner or third-party shares', () => {
  const writer = `drive permissions create --fileId f --json '{"type":"user","role":"writer","emailAddress":"caller@psd401.net"}'`;
  assert.equal(enforcePhase1Gates(writer, agentCtx).allowed, false);
  const thirdParty = `drive permissions create --fileId f --json '{"type":"user","role":"reader","emailAddress":"stranger@evil.com"}'`;
  assert.equal(enforcePhase1Gates(thirdParty, agentCtx).allowed, false);
  const anyone = `drive permissions create --fileId f --json '{"type":"anyone","role":"reader"}'`;
  assert.equal(enforcePhase1Gates(anyone, agentCtx).allowed, false);
});

test('exception requires agent_account scope (user_account cannot share)', () => {
  const cmd = `drive permissions create --fileId f --json '{"type":"user","role":"reader","emailAddress":"caller@psd401.net"}'`;
  assert.equal(enforcePhase1Gates(cmd, userCtx).allowed, false);
});
