/**
 * Regression tests for findUnqualifiedNumericCasts (FS#162394 / issue #1106):
 * numeric columns silently disappear from query results/CSV exports when the
 * agent's generated SQL casts to NUMERIC/DECIMAL without precision, which
 * psd-data-mcp rejects server-side. This client-side check catches the
 * pattern before the request ever leaves the skill.
 */

'use strict';

const { test, expect } = require('bun:test');

require('./mcp-test-support');

const { findUnqualifiedNumericCasts } = require('./common');

test('flags a bare CAST(...AS NUMERIC) with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score AS NUMERIC) FROM iready_scores'
  );
  expect(found).toEqual(['AS NUMERIC)']);
});

test('flags a bare CAST(...AS DECIMAL) with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score AS DECIMAL) FROM iready_scores'
  );
  expect(found).toEqual(['AS DECIMAL)']);
});

test('flags bare shorthand ::numeric with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT score::numeric FROM iready_scores'
  );
  expect(found).toEqual(['::numeric']);
});

test('flags bare shorthand ::decimal with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT score::decimal FROM iready_scores'
  );
  expect(found).toEqual(['::decimal']);
});

test('does not flag CAST(...AS NUMERIC(10,2)) with explicit precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score AS NUMERIC(10,2)) FROM iready_scores'
  );
  expect(found).toEqual([]);
});

test('does not flag ::numeric(10,2) shorthand with explicit precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT score::numeric(10,2) FROM iready_scores'
  );
  expect(found).toEqual([]);
});

test('does not flag CAST(...AS NUMERIC(10,2)) with whitespace before the parens', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score AS NUMERIC (10,2)) FROM iready_scores'
  );
  expect(found).toEqual([]);
});

test('handles nested parens inside the casted expression', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(ROUND(score, 2) AS NUMERIC) FROM iready_scores'
  );
  expect(found).toEqual(['AS NUMERIC)']);
});

test('returns no matches for SQL with no numeric casts at all', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT student_id, first_name FROM students WHERE active = true'
  );
  expect(found).toEqual([]);
});

test('finds every unqualified cast when several are present', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(math_score AS NUMERIC), reading_score::decimal FROM iready_scores'
  );
  expect(found).toEqual(['AS NUMERIC)', '::decimal']);
});

test('is case-insensitive on the type keyword', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score as Numeric) FROM iready_scores'
  );
  expect(found).toEqual(['as Numeric)']);
});

test('returns an empty array for non-string input', () => {
  expect(findUnqualifiedNumericCasts(undefined)).toEqual([]);
  expect(findUnqualifiedNumericCasts(null)).toEqual([]);
});
