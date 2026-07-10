'use strict';
// Tests for parseDate's explicit-date handling (REV-COR-331).
//
// The agent container runs TZ=America/Los_Angeles. Before the fix, an explicit
// `YYYY-MM-DD` argument was parsed as UTC midnight and read back with local
// getters, shifting the result to the *previous* calendar day. Run this suite
// under Pacific time so a regression is caught:
//   TZ=America/Los_Angeles node --test   (see package.json "test" script)

const { test } = require('node:test');
const assert = require('node:assert');

const { parseDate, formatDate } = require('./api.js');

test('explicit YYYY-MM-DD is not shifted back a day', () => {
  // Winter (UTC-8) and summer (UTC-7) both used to underflow to the prior day.
  assert.strictEqual(parseDate('2026-01-15').date, '2026-01-15');
  assert.strictEqual(parseDate('2026-07-04').date, '2026-07-04');
});

test('explicit-date label names the requested calendar day', () => {
  // 2026-01-15 is a Thursday; the label is built from the same Date, so once
  // the date no longer underflows, the weekday is correct too.
  assert.match(parseDate('2026-01-15').label, /Thursday/);
});

test('non-ISO date format (MM/DD/YYYY) parses instead of producing Invalid Date (gemini-code-assist review)', () => {
  // `new Date('01/15/2026')` already parses as LOCAL time in Node, so this
  // format must NOT go through the `${dateArg}T00:00:00` YYYY-MM-DD path —
  // appending T00:00:00 to a non-ISO string produces Invalid Date.
  const r = parseDate('01/15/2026');
  assert.strictEqual(r.date, '2026-01-15');
});

test('today branch is unchanged (local now)', () => {
  const now = new Date();
  const r = parseDate('today');
  assert.strictEqual(r.date, formatDate(now));
  assert.strictEqual(r.label, 'today');
});

test('yesterday branch is unchanged (local now - 1 day)', () => {
  const now = new Date();
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  assert.strictEqual(parseDate('yesterday').date, formatDate(y));
  assert.strictEqual(parseDate('yesterday').label, 'yesterday');
});

test('bare day-name branch is unchanged (most recent past that weekday)', () => {
  const now = new Date();
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const target = DAY_NAMES.indexOf('monday');
  let daysBack = now.getDay() - target;
  if (daysBack < 0) daysBack += 7;
  if (daysBack === 0) daysBack = 7;
  const t = new Date(now);
  t.setDate(t.getDate() - daysBack);
  assert.strictEqual(parseDate('monday').date, formatDate(t));
});

test('undefined argument defaults to today', () => {
  assert.strictEqual(parseDate(undefined).date, formatDate(new Date()));
});
