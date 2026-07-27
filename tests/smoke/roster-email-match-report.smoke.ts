/**
 * Real-PostgreSQL CLI smoke for Issue #1315.
 *
 * Creates a disposable database and proves all three operator-facing outcomes:
 * clean data exits 0, representative findings exit 1, and a connection failure
 * exits 2. The report process performs no writes; only this fixture owns the
 * temporary database and rows.
 */

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { scriptLogger as log } from "../../scripts/db/script-logger";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceDatabaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";
const databaseName = `aistudio_roster_report_${process.pid}_${Date.now()}`;

function databaseUrl(database: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function runReport(
  url: string,
  includeSensitiveSamples = false
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["run", "scripts/db/report-roster-email-match.ts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: url,
        DB_SSL: process.env.DB_SSL ?? "false",
        ROSTER_REPORT_INCLUDE_PII: includeSensitiveSamples ? "true" : "false",
      },
    }
  );
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const adminSql = postgres(databaseUrl("postgres"), {
  ssl: sslEnabled ? "require" : false,
  max: 1,
});

log.section("OneRoster email-match report PostgreSQL smoke");
await adminSql`CREATE DATABASE ${adminSql(databaseName)}`;

const fixtureUrl = databaseUrl(databaseName);
const fixtureSql = postgres(fixtureUrl, {
  ssl: sslEnabled ? "require" : false,
  max: 1,
});

try {
  await fixtureSql`
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email text
    )
  `;
  await fixtureSql`
    CREATE TABLE oneroster_users (
      sourced_id text PRIMARY KEY,
      email text,
      role text,
      is_active boolean NOT NULL DEFAULT true
    )
  `;
  await fixtureSql`
    CREATE TABLE oneroster_classes (
      sourced_id text PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
    )
  `;
  await fixtureSql`
    CREATE TABLE oneroster_enrollments (
      sourced_id text PRIMARY KEY,
      user_sourced_id text,
      class_sourced_id text,
      role text,
      is_active boolean NOT NULL DEFAULT true
    )
  `;

  await fixtureSql`
    INSERT INTO users (email)
    VALUES ('STUDENT@edtools.psd401.net'), ('teacher@psd401.net')
  `;
  await fixtureSql`
    INSERT INTO oneroster_users (sourced_id, email, role)
    VALUES
      ('student-1', 'student@edtools.psd401.net', 'student'),
      ('teacher-1', 'TEACHER@psd401.net', 'teacher')
  `;
  await fixtureSql`
    INSERT INTO oneroster_classes (sourced_id)
    VALUES ('class-1')
  `;
  await fixtureSql`
    INSERT INTO oneroster_enrollments (
      sourced_id,
      user_sourced_id,
      class_sourced_id,
      role
    )
    VALUES ('enrollment-1', 'student-1', 'class-1', 'student')
  `;

  const cleanResult = runReport(fixtureUrl);
  const cleanOutput = combinedOutput(cleanResult);
  assert.equal(cleanResult.status, 0, cleanOutput);
  assert.match(cleanOutput, /Student domain \(@edtools\.psd401\.net\)/);
  assert.match(cleanOutput, /Staff domain \(@psd401\.net\)/);
  assert.match(
    cleanOutput,
    /No roster email-match, domain, duplicate, or referential-drift findings/
  );

  await fixtureSql`
    INSERT INTO oneroster_users (sourced_id, email, role)
    VALUES
      ('unmatched-1', 'unmatched@edtools.psd401.net', 'student'),
      ('duplicate-1', 'duplicate@psd401.net', 'teacher'),
      ('duplicate-2', 'DUPLICATE@psd401.net', 'aide'),
      ('unexpected-domain-1', 'domain-drift@example.test', 'student')
  `;
  await fixtureSql`
    INSERT INTO oneroster_enrollments (
      sourced_id,
      user_sourced_id,
      class_sourced_id,
      role
    )
    VALUES
      ('enrollment-missing-both', 'missing-user', 'missing-class', 'student')
  `;

  const [beforeFindingsRun] = await fixtureSql<
    { users: number; roster_users: number; enrollments: number }[]
  >`
    SELECT (SELECT count(*)::int FROM users) AS users,
           (SELECT count(*)::int FROM oneroster_users) AS roster_users,
           (SELECT count(*)::int FROM oneroster_enrollments) AS enrollments
  `;
  const findingsResult = runReport(fixtureUrl);
  const findingsOutput = combinedOutput(findingsResult);
  assert.equal(findingsResult.status, 1, findingsOutput);
  assert.match(findingsOutput, /\[redacted\]@edtools\.psd401\.net/);
  assert.match(findingsOutput, /Duplicate roster email/);
  assert.match(findingsOutput, /\[redacted\]@psd401\.net/);
  assert.match(findingsOutput, /Enrollment referential drift/);
  assert.match(findingsOutput, /enrollmentSourcedId.*\[redacted\]/);
  assert.doesNotMatch(findingsOutput, /unmatched@edtools\.psd401\.net/);
  assert.doesNotMatch(findingsOutput, /duplicate@psd401\.net/);
  assert.doesNotMatch(findingsOutput, /enrollment-missing-both/);
  assert.match(findingsOutput, /Roster data-quality findings require review/);

  const sensitiveFindingsResult = runReport(fixtureUrl, true);
  const sensitiveFindingsOutput = combinedOutput(sensitiveFindingsResult);
  assert.equal(sensitiveFindingsResult.status, 1, sensitiveFindingsOutput);
  assert.match(
    sensitiveFindingsOutput,
    /Raw roster identifiers are enabled/
  );
  assert.match(
    sensitiveFindingsOutput,
    /unmatched@edtools\.psd401\.net/
  );
  assert.match(sensitiveFindingsOutput, /duplicate@psd401\.net/);
  assert.match(sensitiveFindingsOutput, /enrollment-missing-both/);

  const [afterFindingsRun] = await fixtureSql<
    { users: number; roster_users: number; enrollments: number }[]
  >`
    SELECT (SELECT count(*)::int FROM users) AS users,
           (SELECT count(*)::int FROM oneroster_users) AS roster_users,
           (SELECT count(*)::int FROM oneroster_enrollments) AS enrollments
  `;
  assert.deepEqual(
    afterFindingsRun,
    beforeFindingsRun,
    "the report must not mutate application or roster rows"
  );

  const failureResult = runReport(
    databaseUrl(`${databaseName}_does_not_exist`)
  );
  const failureOutput = combinedOutput(failureResult);
  assert.equal(failureResult.status, 2, failureOutput);
  assert.match(failureOutput, /OneRoster email-match report failed to run/);

  log.success(
    "Clean, redacted and opt-in findings, failure, output, and read-only checks passed."
  );
} finally {
  await fixtureSql.end();
  await adminSql`DROP DATABASE IF EXISTS ${adminSql(databaseName)} WITH (FORCE)`;
  await adminSql.end();
}
