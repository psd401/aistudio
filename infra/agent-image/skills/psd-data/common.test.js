/**
 * Regression tests for findUnqualifiedNumericCasts (FS#162394 / issue #1106):
 * numeric columns silently disappear from query results/CSV exports when the
 * agent's generated SQL casts to NUMERIC/DECIMAL without precision, which
 * psd-data-mcp rejects server-side. This client-side check catches the
 * pattern before the request ever leaves the skill.
 *
 * The scanner only flags actual `CAST(...)` calls and `::TYPE` shorthand —
 * not bare `... AS numeric`/`... AS decimal` column aliases that share the
 * same trailing text but aren't a cast, and not text inside string literals
 * — both confirmed false-positive gaps found in self-review before this
 * landed (see the `blankStringLiterals`/paren-depth-matching approach in
 * common.js instead of the earlier boundary-only regex).
 */

'use strict';

const { test, expect } = require('bun:test');

require('./mcp-test-support');

const { findUnqualifiedNumericCasts } = require('./common');

test('flags a bare CAST(...AS NUMERIC) with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score AS NUMERIC) FROM iready_scores'
  );
  expect(found).toEqual(['CAST(score AS NUMERIC)']);
});

test('flags a bare CAST(...AS DECIMAL) with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score AS DECIMAL) FROM iready_scores'
  );
  expect(found).toEqual(['CAST(score AS DECIMAL)']);
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
  expect(found).toEqual(['CAST(ROUND(score, 2) AS NUMERIC)']);
});

test('handles a nested CAST inside the casted expression independently', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(CAST(score AS INTEGER) AS NUMERIC) FROM iready_scores'
  );
  // Only the outer cast is unqualified; the inner CAST(...AS INTEGER) isn't
  // NUMERIC/DECIMAL at all and must not be reported.
  expect(found).toEqual(['CAST(CAST(score AS INTEGER) AS NUMERIC)']);
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
  expect(found).toEqual(['CAST(math_score AS NUMERIC)', '::decimal']);
});

test('is case-insensitive on the type keyword', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT CAST(score as Numeric) FROM iready_scores'
  );
  expect(found).toEqual(['CAST(score as Numeric)']);
});

test('returns an empty array for non-string input', () => {
  expect(findUnqualifiedNumericCasts(undefined)).toEqual([]);
  expect(findUnqualifiedNumericCasts(null)).toEqual([]);
});

test('does not flag a bare column alias literally named "numeric" with no CAST at all', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT id, score AS numeric FROM (SELECT id, score) sub'
  );
  expect(found).toEqual([]);
});

test('does not flag a bare column alias literally named "decimal" as the last item in a subquery', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT * FROM (SELECT id, score AS decimal) sub'
  );
  expect(found).toEqual([]);
});

test('does not flag cast-like text inside a string literal', () => {
  const found = findUnqualifiedNumericCasts(
    "SELECT * FROM notes WHERE note_text LIKE '%CAST(x AS NUMERIC)%'"
  );
  expect(found).toEqual([]);
});

test('does not flag shorthand-like text inside a string literal', () => {
  const found = findUnqualifiedNumericCasts(
    "SELECT * FROM notes WHERE note_text LIKE '%score::decimal%'"
  );
  expect(found).toEqual([]);
});

test('still flags a real unqualified cast alongside an unrelated string literal', () => {
  const found = findUnqualifiedNumericCasts(
    "SELECT CAST(score AS NUMERIC), 'CAST(x AS NUMERIC) in a note' AS label FROM t"
  );
  expect(found).toEqual(['CAST(score AS NUMERIC)']);
});

test("handles '' escaped quotes inside string literals without breaking scan position", () => {
  const found = findUnqualifiedNumericCasts(
    "SELECT CAST(score AS NUMERIC), 'it''s CAST(x AS NUMERIC) here' AS label FROM t"
  );
  expect(found).toEqual(['CAST(score AS NUMERIC)']);
});

test("handles backslash-escaped quotes inside E'' string literals without breaking scan position", () => {
  const found = findUnqualifiedNumericCasts(
    "SELECT CAST(score AS NUMERIC), E'it\\'s CAST(x AS NUMERIC) here' AS label FROM t"
  );
  expect(found).toEqual(['CAST(score AS NUMERIC)']);
});

test('does not let a backslash swallow a real cast in a standard (non-E) string literal', () => {
  // Under Postgres's default standard_conforming_strings=on, a plain '...'
  // literal does NOT treat backslash as an escape — only '' (doubled quote)
  // does. So 'a\' terminates at that quote, and the CAST below is live SQL
  // that must still be flagged, not swallowed as if it were inside a string.
  const found = findUnqualifiedNumericCasts(
    "SELECT 1 WHERE x = 'a\\' AND CAST(score AS NUMERIC) FROM t"
  );
  expect(found).toEqual(['CAST(score AS NUMERIC)']);
});

test('ignores unqualified casts inside single-line comments', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT id FROM t -- CAST(score AS NUMERIC)\nSELECT score::numeric FROM t'
  );
  expect(found).toEqual(['::numeric']);
});

test('ignores unqualified casts inside multi-line comments', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT id FROM t /* CAST(score AS NUMERIC) */'
  );
  expect(found).toEqual([]);
});

test('flags a bare TRY_CAST(...AS NUMERIC) with no precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT TRY_CAST(score AS NUMERIC) FROM iready_scores'
  );
  expect(found).toEqual(['TRY_CAST(score AS NUMERIC)']);
});

test('does not flag TRY_CAST(...AS NUMERIC(10,2)) with explicit precision', () => {
  const found = findUnqualifiedNumericCasts(
    'SELECT TRY_CAST(score AS NUMERIC(10,2)) FROM iready_scores'
  );
  expect(found).toEqual([]);
});
