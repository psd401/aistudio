import { mkdir } from "node:fs/promises";
import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";
import type { Page, TestInfo } from "@playwright/test";

const settingKeys = [
  "ROSTER_SYNC_ENABLED",
  "ONEROSTER_BASE_URL",
  "ONEROSTER_AUTH_MODE",
  "ONEROSTER_CREDENTIALS_SECRET_ARN",
  "ONEROSTER_API_VERSION",
  "ONEROSTER_PAGE_SIZE",
] as const;

type RosterSql = ReturnType<typeof import("postgres")>;
type OriginalSetting = {
  key: string;
  value: string | null;
  description: string | null;
  category: string | null;
  is_secret: boolean | null;
};
type RosterFixtureIds = {
  schoolId: string;
  termId: string;
  classId: string;
  teacherId: string;
  studentId: string;
  teacherEnrollmentId: string;
  studentEnrollmentId: string;
};

function createRosterFixtureIds(stamp: number): RosterFixtureIds {
  return {
    schoolId: `e2e-school-${stamp}`,
    termId: `e2e-term-${stamp}`,
    classId: `e2e-class-${stamp}`,
    teacherId: `e2e-teacher-${stamp}`,
    studentId: `e2e-student-${stamp}`,
    teacherEnrollmentId: `e2e-teacher-enrollment-${stamp}`,
    studentEnrollmentId: `e2e-student-enrollment-${stamp}`,
  };
}

async function configureRosterSettings(sql: RosterSql): Promise<OriginalSetting[]> {
  const originalSettings = await sql<OriginalSetting[]>`
    SELECT key, value, description, category, is_secret
      FROM settings
     WHERE key IN ${sql([...settingKeys])}
  `;
  const region =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
  const accountId = process.env.AWS_ACCOUNT_ID ?? "123456789012";
  const environment =
    process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev";
  const settingValues = [
    ["ROSTER_SYNC_ENABLED", "false"],
    ["ONEROSTER_BASE_URL", "https://district.example.org"],
    ["ONEROSTER_AUTH_MODE", "oauth1"],
    [
      "ONEROSTER_CREDENTIALS_SECRET_ARN",
      `arn:aws:secretsmanager:${region}:${accountId}:secret:aistudio-${environment}-oneroster-e2e`,
    ],
    ["ONEROSTER_API_VERSION", "v1p1"],
    ["ONEROSTER_PAGE_SIZE", "10000"],
  ] as const;
  for (const [key, value] of settingValues) {
    await sql`
      INSERT INTO settings (key, value, category, is_secret)
      VALUES (${key}, ${value}, 'integrations',
        ${key === "ONEROSTER_CREDENTIALS_SECRET_ARN"})
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            category = EXCLUDED.category,
            is_secret = EXCLUDED.is_secret,
            updated_at = now()
    `;
  }
  return originalSettings;
}

async function seedRosterFixtures(
  sql: RosterSql,
  ids: RosterFixtureIds,
  stamp: number
): Promise<void> {
  await sql`
    INSERT INTO oneroster_orgs (
      sourced_id, name, type, identifier, status, is_active, last_synced_at
    ) VALUES (
      ${ids.schoolId}, 'E2E Cedar School', 'school', 'E2E-CEDAR',
      'active', true, now()
    )
  `;
  await sql`
    INSERT INTO oneroster_academic_sessions (
      sourced_id, title, type, status, is_active, last_synced_at
    ) VALUES (${ids.termId}, 'E2E Fall Term', 'term', 'active', true, now())
  `;
  await sql`
    INSERT INTO oneroster_classes (
      sourced_id, title, class_code, school_sourced_id, status,
      is_active, last_synced_at
    ) VALUES (
      ${ids.classId}, 'E2E Biology', 'BIO-E2E', ${ids.schoolId}, 'active',
      true, now()
    )
  `;
  await sql`
    INSERT INTO oneroster_class_terms (
      class_sourced_id, term_sourced_id, status, is_active, last_synced_at
    ) VALUES (${ids.classId}, ${ids.termId}, 'active', true, now())
  `;
  await sql`
    INSERT INTO oneroster_users (
      sourced_id, email, given_name, family_name, role, status,
      is_active, last_synced_at
    ) VALUES
      (
        ${ids.teacherId}, ${`teacher-${stamp}@psd401.net`}, 'Taylor',
        'Teacher', 'teacher', 'active', true, now()
      ),
      (
        ${ids.studentId}, ${`student-${stamp}@edtools.psd401.net`}, 'Sam',
        'Student', 'student', 'active', true, now()
      )
  `;
  await sql`
    INSERT INTO oneroster_enrollments (
      sourced_id, user_sourced_id, class_sourced_id, school_sourced_id,
      role, is_primary, status, is_active, last_synced_at
    ) VALUES
      (
        ${ids.teacherEnrollmentId}, ${ids.teacherId}, ${ids.classId},
        ${ids.schoolId}, 'teacher', true, 'active', true, now()
      ),
      (
        ${ids.studentEnrollmentId}, ${ids.studentId}, ${ids.classId},
        ${ids.schoolId}, 'student', true, 'active', true, now()
      )
  `;
}

async function verifyRosterAdminPage(
  page: Page,
  sql: RosterSql,
  ids: RosterFixtureIds,
  testInfo: TestInfo
): Promise<void> {
  await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
  await page.goto("/admin/rosters");
  await expect(page.locator("h1").filter({ hasText: /^Rosters$/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("rosters-admin")).toBeVisible();
  await expect(page.getByTestId("roster-base-url")).toHaveValue(
    "https://district.example.org"
  );
  await page.getByTestId("roster-page-size").fill("4321");
  await page.getByTestId("roster-settings-save").click();
  await expect
    .poll(async () => {
      const [row] = await sql<{ value: string | null }[]>`
        SELECT value FROM settings WHERE key = 'ONEROSTER_PAGE_SIZE'
      `;
      return row?.value;
    }, { timeout: 10_000 })
    .toBe("4321");

  await page.getByTestId("tab-roster-sync").click();
  await expect(page.getByTestId("roster-collection-summary")).toBeVisible();
  await expect(page.getByText("Organizations", { exact: true })).toBeVisible();
  await expect(page.getByTestId("roster-sync-now")).toBeEnabled();
  await page.getByTestId("tab-roster-browser").click();
  await page.getByTestId("roster-school-select").click();
  await page.getByRole("option", { name: "E2E Cedar School" }).click();
  await expect(page.getByTestId("roster-classes-table")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("E2E Biology", { exact: true })).toBeVisible();
  await expect(page.getByText("Taylor Teacher", { exact: true })).toBeVisible();
  await page.getByTestId(`view-roster-${ids.classId}`).click();
  await expect(page.getByTestId("roster-students-table")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Sam Student", { exact: true })).toBeVisible();
  await mkdir(".verification", { recursive: true });
  await page.screenshot({
    path: `.verification/admin-rosters-${testInfo.project.name}.png`,
    fullPage: true,
  });
}

async function cleanupRosterFixtures(
  sql: RosterSql,
  ids: RosterFixtureIds,
  originalSettings: OriginalSetting[]
): Promise<void> {
  await sql`
    DELETE FROM oneroster_enrollments
     WHERE sourced_id IN (${ids.teacherEnrollmentId}, ${ids.studentEnrollmentId})
  `;
  await sql`
    DELETE FROM oneroster_users
     WHERE sourced_id IN (${ids.teacherId}, ${ids.studentId})
  `;
  await sql`
    DELETE FROM oneroster_class_terms WHERE class_sourced_id = ${ids.classId}
  `;
  await sql`DELETE FROM oneroster_classes WHERE sourced_id = ${ids.classId}`;
  await sql`
    DELETE FROM oneroster_academic_sessions WHERE sourced_id = ${ids.termId}
  `;
  await sql`DELETE FROM oneroster_orgs WHERE sourced_id = ${ids.schoolId}`;
  await sql`DELETE FROM settings WHERE key IN ${sql([...settingKeys])}`;
  for (const row of originalSettings) {
    await sql`
      INSERT INTO settings (key, value, description, category, is_secret)
      VALUES (
        ${row.key}, ${row.value}, ${row.description}, ${row.category},
        ${row.is_secret}
      )
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            description = EXCLUDED.description,
            category = EXCLUDED.category,
            is_secret = EXCLUDED.is_secret,
            updated_at = now()
    `;
  }
  await sql.end();
}

const defineAdminOneRosterPage1311Suite1Registration1: NonNullable<Parameters<typeof test>[2]> = async ({
    page,
  }, testInfo) => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(
      process.env.E2E_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/aistudio",
      { ssl: process.env.E2E_DB_SSL === "true" }
    );
    const stamp = Date.now();
    const ids = createRosterFixtureIds(stamp);
    const originalSettings = await configureRosterSettings(sql);

    try {
      await seedRosterFixtures(sql, ids, stamp);
      await verifyRosterAdminPage(page, sql, ids, testInfo);
    } finally {
      await cleanupRosterFixtures(sql, ids, originalSettings);
    }
  };

const defineAdminOneRosterPage1311Suite1 = () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host :3100 dev server"
  );

  test("persists settings and browses seeded school, class, and student rows", defineAdminOneRosterPage1311Suite1Registration1);
};

test.describe("Admin OneRoster page (#1311)", defineAdminOneRosterPage1311Suite1);
