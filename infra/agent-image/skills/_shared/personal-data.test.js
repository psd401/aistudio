'use strict';

/**
 * The agent image's CJS half of the #1886 gate (chat-chart's reader).
 *
 * What matters most here is that this loader reads the SAME committed file the
 * Next.js broker imports, and agrees with the other two loaders on the shared
 * cases in tests/fixtures/personal-data-cases.json — so the agent container
 * and the web broker can never disagree about what counts as personal data.
 */

const { test, expect } = require('bun:test');
const path = require('node:path');

const {
  firstPersonalDataKind,
  PERSONAL_DATA_PATTERN_COUNT,
} = require('./personal-data');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const CANONICAL = path.join(REPO_ROOT, 'lib', 'safety', 'personal-data-patterns.json');
const CASES = require(path.join(REPO_ROOT, 'tests', 'fixtures', 'personal-data-cases.json')).cases;

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

test.each(CASES.map((entry) => [entry.name, entry]))(
  'shared case: %s',
  (_name, entry) => {
    const kind = firstPersonalDataKind(entry.text);
    if (entry.present.length === 0) {
      expect(kind).toBeNull();
    } else {
      expect(entry.present).toContain(kind);
    }
  }
);

test('repeated calls do not carry regex lastIndex state between them', () => {
  // A module-level global RegExp reused with .exec/.test would alternate
  // between finding and missing the same match.
  const text = 'student 2123456 enrolled';
  for (let i = 0; i < 4; i++) {
    expect(firstPersonalDataKind(text)).toBe('psd-student-id');
  }
});
