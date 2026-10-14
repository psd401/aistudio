'use strict';

/**
 * The agent image's half of the #1886 gate.
 *
 * Two things are under test, and the second matters more than it looks:
 *
 *  1. the two policies behave differently in the one way they are supposed to
 *     — a public FILE may carry one contact detail (the school phone number in
 *     a flyer footer), narration may not carry any;
 *  2. this loader reads the SAME committed file the Next.js broker imports, so
 *     the agent container and the web broker can never disagree about what
 *     counts as personal data.
 */

const { test, expect } = require('bun:test');
const path = require('node:path');

const {
  firstPersonalDataKind,
  personalDataKinds,
  PERSONAL_DATA_PATTERN_COUNT,
} = require('./personal-data');

const CANONICAL = path.join(
  __dirname, '..', '..', '..', '..', 'lib', 'safety', 'personal-data-patterns.json'
);

test('reads the same canonical file the Next.js broker imports', () => {
  const canonical = require(CANONICAL);
  expect(PERSONAL_DATA_PATTERN_COUNT).toBe(canonical.patterns.length);
  expect(PERSONAL_DATA_PATTERN_COUNT).toBeGreaterThan(0);
});

test('firstPersonalDataKind finds each kind and short-circuits on clean text', () => {
  expect(firstPersonalDataKind('reach me at a@b.com')).toBe('email');
  expect(firstPersonalDataKind('ssn 123-45-6789')).toBe('ssn');
  expect(firstPersonalDataKind('call (206) 555-1212 today')).toBe('us-phone');
  expect(firstPersonalDataKind('student 2123456 enrolled')).toBe('psd-student-id');
  expect(firstPersonalDataKind('apples 5 oranges 7')).toBeNull();
});

test('a public FILE may carry one contact detail; narration may not', () => {
  const flyer = 'Open house Thursday. Questions? Call 253-530-1000.';
  expect(personalDataKinds(flyer, 'publicFile')).toEqual([]);
  expect(personalDataKinds(flyer, 'narration')).toEqual(['us-phone']);
});

test('two distinct contact details are a contact list, and refused as a file', () => {
  const list = 'A. Hall 253-555-0147\nB. Reyes 253-555-0192';
  expect(personalDataKinds(list, 'publicFile')).toEqual(['us-phone']);
});

test('the same number repeated is still one number', () => {
  const flyer = 'Call 253-530-1000.\nFooter: 253-530-1000';
  expect(personalDataKinds(flyer, 'publicFile')).toEqual([]);
});

test('a student ID or an SSN is refused on its own, with no list threshold', () => {
  expect(personalDataKinds('row,2240393', 'publicFile')).toEqual(['psd-student-id']);
  expect(personalDataKinds('ssn 123-45-6789', 'publicFile')).toEqual(['ssn']);
});

test('kinds come back sorted, and never the matched values', () => {
  const both = 'ahall@psd401.net 253-555-0147\nbreyes@psd401.net 253-555-0192';
  const kinds = personalDataKinds(both, 'publicFile');
  expect(kinds).toEqual(['email', 'us-phone']);
  expect(kinds.join(' ')).not.toContain('psd401');
  expect(kinds.join(' ')).not.toContain('555');
});

test('an unknown policy name is a programming error, not a silent pass', () => {
  expect(() => personalDataKinds('anything', 'publicfile')).toThrow(/policy/);
});

test('repeated calls do not carry regex lastIndex state between them', () => {
  // A module-level global RegExp reused with .exec/.test would alternate
  // between finding and missing the same match.
  const text = 'student 2123456 enrolled';
  for (let i = 0; i < 4; i++) {
    expect(firstPersonalDataKind(text)).toBe('psd-student-id');
    expect(personalDataKinds(text, 'narration')).toEqual(['psd-student-id']);
  }
});

test('the scan stays linear on a 120KB payload', () => {
  // The pattern file's bounded quantifiers are what make this hold; chat-chart
  // has the same guard at the CLI level.
  const payload = 'a'.repeat(120_000);
  const started = Date.now();
  expect(personalDataKinds(payload, 'publicFile')).toEqual([]);
  expect(Date.now() - started).toBeLessThan(2000);
});
