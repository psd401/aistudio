'use strict';
// Tests for run.js argument handling + submit-payload validation (#1230).
//
// The validators call process.exit on bad input (the skill's error contract).
// We stub process.exit to throw so failures are observable, and capture stdout
// to assert the emitted status/message.
//
// Run: node --test   (from skills/psd-classified-evaluation/)

const { test } = require('node:test');
const assert = require('node:assert');

const { requireUser, buildSubmitArgs, statusForCode } = require('./run');

// Run `fn` with process.exit + stdout stubbed. Returns { result, exitCode, out }.
function capture(fn) {
  const origExit = process.exit;
  const origWrite = process.stdout.write;
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error(`__exit_${code}`); };
  let result;
  try {
    result = fn();
  } catch (err) {
    if (!/^__exit_/.test(err.message)) throw err;
  } finally {
    process.exit = origExit;
    process.stdout.write = origWrite;
  }
  return { result, exitCode, out: out.join('') };
}

test('statusForCode maps exit codes to statuses', () => {
  assert.strictEqual(statusForCode(11), 'not-configured');
  assert.strictEqual(statusForCode(12), 'transport-error');
  assert.strictEqual(statusForCode(13), 'gateway-error');
  assert.strictEqual(statusForCode(2), 'bad-args');
});

test('requireUser accepts a valid email and rejects a missing/invalid one', () => {
  assert.strictEqual(capture(() => requireUser({ user: 'hagelk@psd401.net' })).result, 'hagelk@psd401.net');
  assert.strictEqual(capture(() => requireUser({})).exitCode, 2);
  assert.strictEqual(capture(() => requireUser({ user: 'not-an-email' })).exitCode, 2);
});

const validPayload = () => ({
  employee_email: 'employee@psd401.net',
  rating_reliability: 'Good',
  rating_quality: 'Outstanding',
  rating_teamwork: 'Satisfactory',
  supervisor_comments: "It's been a strong year.",
});

test('buildSubmitArgs binds evaluator_email from --user, overriding any payload value', () => {
  const payload = { ...validPayload(), evaluator_email: 'attacker@psd401.net' };
  const { result } = capture(() => buildSubmitArgs('boss@psd401.net', payload));
  assert.strictEqual(result.evaluator_email, 'boss@psd401.net'); // bound, not trusted
  assert.strictEqual(result.employee_email, 'employee@psd401.net');
  assert.strictEqual(result.rating_reliability, 'Good');
  assert.strictEqual(result.supervisor_comments, "It's been a strong year.");
});

test('buildSubmitArgs rejects a missing/invalid employee_email', () => {
  const p = validPayload(); delete p.employee_email;
  assert.strictEqual(capture(() => buildSubmitArgs('boss@psd401.net', p)).exitCode, 2);
  assert.strictEqual(
    capture(() => buildSubmitArgs('boss@psd401.net', { ...validPayload(), employee_email: 'nope' })).exitCode,
    2
  );
});

test('buildSubmitArgs rejects when there are no rating_* keys', () => {
  const { exitCode } = capture(() => buildSubmitArgs('boss@psd401.net', { employee_email: 'e@psd401.net' }));
  assert.strictEqual(exitCode, 2);
});

test('buildSubmitArgs rejects an out-of-set rating value', () => {
  const bad = { ...validPayload(), rating_reliability: 'Excellent' }; // not one of the five
  const { exitCode, out } = capture(() => buildSubmitArgs('boss@psd401.net', bad));
  assert.strictEqual(exitCode, 2);
  assert.match(out, /rating_reliability/);
});

test('buildSubmitArgs rejects non-string supervisor_comments', () => {
  const bad = { ...validPayload(), supervisor_comments: 42 };
  assert.strictEqual(capture(() => buildSubmitArgs('boss@psd401.net', bad)).exitCode, 2);
});
