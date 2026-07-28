/**
 * OneRoster email-match and referential-drift report (Epic #1308 / Issue #1315).
 *
 * Run this read-only readiness check after a complete manual OneRoster sync and
 * before enabling roster-driven roles or creating production rooms:
 *
 *   DATABASE_URL=postgres://... DB_SSL=true \
 *     bun run scripts/db/report-roster-email-match.ts
 *
 * Sample identifiers are redacted by default. Set
 * ROSTER_REPORT_INCLUDE_PII=true only for a private, non-captured operator
 * session when exact identifiers are required for investigation.
 *
 * Exit codes:
 *   0 — active roster rows all match application users and no integrity hazards
 *       were found.
 *   1 — findings were found; review the counts/samples and the decision rule in
 *       docs/features/oneroster-classlink-sync.md before promotion.
 *   2 — the script itself failed (connection/query error).
 *
 * READ-ONLY: every statement in this file is SELECT-only.
 */

import postgres from "postgres";
import { scriptLogger as log } from "./script-logger";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";
const includeSensitiveSamples =
  process.env.ROSTER_REPORT_INCLUDE_PII === "true";
const SAMPLE_LIMIT = 25;

type EmailCohort =
  "student_domain" | "staff_domain" | "other_domain" | "missing_email";

interface MatchCohortRow {
  cohort: EmailCohort;
  total: number;
  matched: number;
}

interface UnmatchedRosterUserRow {
  email: string | null;
  role: string;
}

interface DuplicateSummaryRow {
  duplicate_email_groups: number;
  roster_rows: number;
}

interface DuplicateSampleRow {
  email: string;
  roster_rows: number;
  roles: string[];
}

interface ReferentialDriftSummaryRow {
  affected_enrollments: number;
  missing_users: number;
  inactive_users: number;
  missing_classes: number;
  inactive_classes: number;
}

interface ReferentialDriftSampleRow {
  enrollment_sourced_id: string;
  user_sourced_id: string | null;
  class_sourced_id: string | null;
  role: string;
  missing_user: boolean;
  inactive_user: boolean;
  missing_class: boolean;
  inactive_class: boolean;
}

interface EmailMatchSummary {
  activeRosterUsers: number;
  unmatchedRosterUsers: number;
  unexpectedDomainUsers: number;
}

function ratePercent(matched: number, total: number): number | null {
  if (total === 0) {
    return null;
  }
  return Number(((matched / total) * 100).toFixed(2));
}

function cohortLabel(cohort: EmailCohort): string {
  switch (cohort) {
    case "student_domain":
      return "Student domain (@edtools.psd401.net)";
    case "staff_domain":
      return "Staff domain (@psd401.net)";
    case "other_domain":
      return "Unexpected domain";
    case "missing_email":
      return "Missing email";
  }
}

function formatEmailSample(email: string | null): string {
  if (email === null) {
    return "(missing)";
  }
  if (includeSensitiveSamples) {
    return email;
  }

  const separatorIndex = email.lastIndexOf("@");
  if (separatorIndex === -1) {
    return "[redacted]";
  }
  return `[redacted]${email.slice(separatorIndex)}`;
}

function formatIdentifierSample(identifier: string | null): string {
  if (identifier === null) {
    return "(missing)";
  }
  return includeSensitiveSamples ? identifier : "[redacted]";
}

async function reportEmailMatches(
  sql: postgres.Sql,
): Promise<EmailMatchSummary> {
  const cohorts = await sql<MatchCohortRow[]>`
      WITH active_roster_users AS (
        SELECT lower(nullif(btrim(email), '')) AS normalized_email,
               CASE
                 WHEN nullif(btrim(email), '') IS NULL THEN 'missing_email'
                 WHEN split_part(lower(btrim(email)), '@', 2) =
                      'edtools.psd401.net' THEN 'student_domain'
                 WHEN split_part(lower(btrim(email)), '@', 2) =
                      'psd401.net' THEN 'staff_domain'
                 ELSE 'other_domain'
               END AS cohort
          FROM oneroster_users
         WHERE is_active = true
      )
      SELECT cohort,
             count(*)::int AS total,
             count(*) FILTER (
               WHERE normalized_email IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM users
                    WHERE lower(users.email) = normalized_email
                 )
             )::int AS matched
        FROM active_roster_users
       GROUP BY cohort
    `;

  const cohortByName = new Map<EmailCohort, MatchCohortRow>(
    cohorts.map((row) => [row.cohort, row]),
  );
  const orderedCohorts: EmailCohort[] = [
    "student_domain",
    "staff_domain",
    "other_domain",
    "missing_email",
  ];
  const totals = cohorts.reduce(
    (summary, row) => ({
      total: summary.total + row.total,
      matched: summary.matched + row.matched,
    }),
    { total: 0, matched: 0 },
  );
  const unmatchedCount = totals.total - totals.matched;
  const unexpectedDomainCount =
    (cohortByName.get("other_domain")?.total ?? 0) +
    (cohortByName.get("missing_email")?.total ?? 0);

  log.section("Active roster email match rate");
  log.info("Overall", {
    activeRosterUsers: totals.total,
    matchedApplicationUsers: totals.matched,
    unmatchedRosterUsers: unmatchedCount,
    matchRatePercent: ratePercent(totals.matched, totals.total),
  });
  for (const cohort of orderedCohorts) {
    const row = cohortByName.get(cohort) ?? {
      cohort,
      total: 0,
      matched: 0,
    };
    log.info(cohortLabel(cohort), {
      activeRosterUsers: row.total,
      matchedApplicationUsers: row.matched,
      unmatchedRosterUsers: row.total - row.matched,
      matchRatePercent: ratePercent(row.matched, row.total),
    });
  }

  return {
    activeRosterUsers: totals.total,
    unmatchedRosterUsers: unmatchedCount,
    unexpectedDomainUsers: unexpectedDomainCount,
  };
}

async function reportUnmatchedRosterUsers(
  sql: postgres.Sql,
  unmatchedCount: number,
): Promise<void> {
  const unmatchedSamples = await sql<UnmatchedRosterUserRow[]>`
      SELECT lower(nullif(btrim(ou.email), '')) AS email,
             coalesce(nullif(btrim(ou.role), ''), 'unknown') AS role
        FROM oneroster_users ou
       WHERE ou.is_active = true
         AND (
           nullif(btrim(ou.email), '') IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM users u
              WHERE lower(u.email) = lower(btrim(ou.email))
           )
         )
       ORDER BY lower(ou.email) NULLS LAST, ou.sourced_id
       LIMIT ${SAMPLE_LIMIT}
    `;

  log.section("Unmatched active roster users (bounded sample)");
  if (unmatchedSamples.length === 0) {
    log.success("No unmatched active roster users.");
  } else {
    log.warn("Sample coverage", {
      showing: unmatchedSamples.length,
      totalUnmatched: unmatchedCount,
    });
    for (const row of unmatchedSamples) {
      log.warn("Unmatched roster user", {
        email: formatEmailSample(row.email),
        role: row.role,
      });
    }
  }
}

async function reportDuplicateRosterEmails(sql: postgres.Sql): Promise<number> {
  const [duplicateSummary] = await sql<DuplicateSummaryRow[]>`
      WITH duplicate_emails AS (
        SELECT lower(btrim(email)) AS email,
               count(*)::int AS roster_rows
          FROM oneroster_users
         WHERE is_active = true
           AND nullif(btrim(email), '') IS NOT NULL
         GROUP BY lower(btrim(email))
        HAVING count(*) > 1
      )
      SELECT count(*)::int AS duplicate_email_groups,
             coalesce(sum(roster_rows), 0)::int AS roster_rows
        FROM duplicate_emails
    `;
  const duplicateSamples = await sql<DuplicateSampleRow[]>`
      SELECT lower(btrim(email)) AS email,
             count(*)::int AS roster_rows,
             array_agg(
               DISTINCT coalesce(nullif(btrim(role), ''), 'unknown')
               ORDER BY coalesce(nullif(btrim(role), ''), 'unknown')
             ) AS roles
        FROM oneroster_users
       WHERE is_active = true
         AND nullif(btrim(email), '') IS NOT NULL
       GROUP BY lower(btrim(email))
      HAVING count(*) > 1
       ORDER BY count(*) DESC, lower(btrim(email))
       LIMIT ${SAMPLE_LIMIT}
    `;
  const duplicateEmailGroups = duplicateSummary?.duplicate_email_groups ?? 0;

  log.section("Duplicate active roster emails");
  log.info("Summary", {
    duplicateEmailGroups,
    affectedRosterRows: duplicateSummary?.roster_rows ?? 0,
    sampleLimit: SAMPLE_LIMIT,
  });
  if (duplicateSamples.length === 0) {
    log.success("No active roster rows share a case-insensitive email.");
  } else {
    for (const row of duplicateSamples) {
      log.warn("Duplicate roster email", {
        email: formatEmailSample(row.email),
        rosterRows: row.roster_rows,
        roles: row.roles,
      });
    }
  }

  return duplicateEmailGroups;
}

async function reportReferentialDrift(sql: postgres.Sql): Promise<number> {
  const [driftSummary] = await sql<ReferentialDriftSummaryRow[]>`
      WITH enrollment_references AS (
        SELECT e.sourced_id,
               (u.sourced_id IS NULL) AS missing_user,
               (u.sourced_id IS NOT NULL AND u.is_active = false)
                 AS inactive_user,
               (c.sourced_id IS NULL) AS missing_class,
               (c.sourced_id IS NOT NULL AND c.is_active = false)
                 AS inactive_class
          FROM oneroster_enrollments e
          LEFT JOIN oneroster_users u
            ON u.sourced_id = e.user_sourced_id
          LEFT JOIN oneroster_classes c
            ON c.sourced_id = e.class_sourced_id
         WHERE e.is_active = true
      )
      SELECT count(*) FILTER (
               WHERE missing_user OR inactive_user
                  OR missing_class OR inactive_class
             )::int AS affected_enrollments,
             count(*) FILTER (WHERE missing_user)::int AS missing_users,
             count(*) FILTER (WHERE inactive_user)::int AS inactive_users,
             count(*) FILTER (WHERE missing_class)::int AS missing_classes,
             count(*) FILTER (WHERE inactive_class)::int AS inactive_classes
        FROM enrollment_references
    `;
  const driftSamples = await sql<ReferentialDriftSampleRow[]>`
      SELECT e.sourced_id AS enrollment_sourced_id,
             e.user_sourced_id,
             e.class_sourced_id,
             coalesce(nullif(btrim(e.role), ''), 'unknown') AS role,
             (u.sourced_id IS NULL) AS missing_user,
             (u.sourced_id IS NOT NULL AND u.is_active = false)
               AS inactive_user,
             (c.sourced_id IS NULL) AS missing_class,
             (c.sourced_id IS NOT NULL AND c.is_active = false)
               AS inactive_class
        FROM oneroster_enrollments e
        LEFT JOIN oneroster_users u
          ON u.sourced_id = e.user_sourced_id
        LEFT JOIN oneroster_classes c
          ON c.sourced_id = e.class_sourced_id
       WHERE e.is_active = true
         AND (
           u.sourced_id IS NULL
           OR u.is_active = false
           OR c.sourced_id IS NULL
           OR c.is_active = false
         )
       ORDER BY e.sourced_id
       LIMIT ${SAMPLE_LIMIT}
    `;
  const affectedEnrollments = driftSummary?.affected_enrollments ?? 0;

  log.section("Active enrollment referential drift");
  log.info("Summary", {
    affectedEnrollments,
    missingUsers: driftSummary?.missing_users ?? 0,
    inactiveUsers: driftSummary?.inactive_users ?? 0,
    missingClasses: driftSummary?.missing_classes ?? 0,
    inactiveClasses: driftSummary?.inactive_classes ?? 0,
    sampleLimit: SAMPLE_LIMIT,
  });
  if (driftSamples.length === 0) {
    log.success(
      "All active enrollments reference active roster users and classes.",
    );
  } else {
    for (const row of driftSamples) {
      log.warn("Enrollment referential drift", {
        enrollmentSourcedId: formatIdentifierSample(row.enrollment_sourced_id),
        userSourcedId: formatIdentifierSample(row.user_sourced_id),
        classSourcedId: formatIdentifierSample(row.class_sourced_id),
        role: row.role,
        missingUser: row.missing_user,
        inactiveUser: row.inactive_user,
        missingClass: row.missing_class,
        inactiveClass: row.inactive_class,
      });
    }
  }

  return affectedEnrollments;
}

function reportPromotionResult(hasFindings: boolean): void {
  log.section("Promotion result");
  if (hasFindings) {
    log.fail(
      "Roster data-quality findings require review before enabling production flags.",
    );
    log.info(
      "Apply the decision rule in docs/features/oneroster-classlink-sync.md; " +
        "document expected never-signed-in users without copying raw email samples.",
    );
    process.exitCode = 1;
  } else {
    log.success(
      "No roster email-match, domain, duplicate, or referential-drift findings.",
    );
    process.exitCode = 0;
  }
}

function logReportConfiguration(): void {
  log.section("AI Studio - OneRoster Email-Match Report (#1315)");
  log.info("Database", { url: DATABASE_URL.replace(/:\/\/.*@/, "://*****@") });
  log.info("Sample limit", { rowsPerSection: SAMPLE_LIMIT });
  log.info("Sensitive sample identifiers", {
    included: includeSensitiveSamples,
  });
  if (includeSensitiveSamples) {
    log.warn(
      "Raw roster identifiers are enabled. Keep this terminal private and do not capture or share its output.",
    );
  }
}

function reportHasFindings(input: {
  activeRosterUsers: number;
  unmatchedRosterUsers: number;
  unexpectedDomainUsers: number;
  duplicateEmailGroups: number;
  affectedEnrollments: number;
}): boolean {
  return [
    input.activeRosterUsers === 0,
    input.unmatchedRosterUsers > 0,
    input.unexpectedDomainUsers > 0,
    input.duplicateEmailGroups > 0,
    input.affectedEnrollments > 0,
  ].some(Boolean);
}

async function main(): Promise<void> {
  logReportConfiguration();
  const sql = postgres(DATABASE_URL, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    const emailMatches = await reportEmailMatches(sql);
    await reportUnmatchedRosterUsers(sql, emailMatches.unmatchedRosterUsers);
    const duplicateEmailGroups = await reportDuplicateRosterEmails(sql);
    const affectedEnrollments = await reportReferentialDrift(sql);
    reportPromotionResult(
      reportHasFindings({
        ...emailMatches,
        duplicateEmailGroups,
        affectedEnrollments,
      }),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  log.error("OneRoster email-match report failed to run", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 2;
});
