import { mkdir } from "node:fs/promises";
import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

const settingKeys = [
  "ROSTER_SYNC_ENABLED",
  "ONEROSTER_BASE_URL",
  "ONEROSTER_AUTH_MODE",
  "ONEROSTER_CREDENTIALS_SECRET_ARN",
  "ONEROSTER_API_VERSION",
  "ONEROSTER_PAGE_SIZE",
] as const;

test.describe("Admin OneRoster page (#1311)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host :3100 dev server"
  );

  test("persists settings and browses seeded school, class, and student rows", async ({
    page,
  }, testInfo) => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(
      process.env.E2E_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/aistudio",
      { ssl: process.env.E2E_DB_SSL === "true" }
    );
    const stamp = Date.now();
    const schoolId = `e2e-school-${stamp}`;
    const termId = `e2e-term-${stamp}`;
    const classId = `e2e-class-${stamp}`;
    const teacherId = `e2e-teacher-${stamp}`;
    const studentId = `e2e-student-${stamp}`;
    const teacherEnrollmentId = `e2e-teacher-enrollment-${stamp}`;
    const studentEnrollmentId = `e2e-student-enrollment-${stamp}`;
    const originalSettings = await sql<{
      key: string;
      value: string | null;
      description: string | null;
      category: string | null;
      is_secret: boolean | null;
    }[]>`
      SELECT key, value, description, category, is_secret
        FROM settings
       WHERE key IN ${sql([...settingKeys])}
    `;

    try {
      const settingValues = [
        ["ROSTER_SYNC_ENABLED", "false"],
        ["ONEROSTER_BASE_URL", "https://district.example.org"],
        ["ONEROSTER_AUTH_MODE", "oauth1"],
        [
          "ONEROSTER_CREDENTIALS_SECRET_ARN",
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:aistudio-dev-oneroster-e2e",
        ],
        ["ONEROSTER_API_VERSION", "v1p1"],
        ["ONEROSTER_PAGE_SIZE", "10000"],
      ] as const;
      for (const [key, value] of settingValues) {
        await sql`
          INSERT INTO settings (key, value, category, is_secret)
          VALUES (
            ${key},
            ${value},
            'integrations',
            ${key === "ONEROSTER_CREDENTIALS_SECRET_ARN"}
          )
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                category = EXCLUDED.category,
                is_secret = EXCLUDED.is_secret,
                updated_at = now()
        `;
      }

      await sql`
        INSERT INTO oneroster_orgs (
          sourced_id, name, type, identifier, status, is_active, last_synced_at
        )
        VALUES (
          ${schoolId}, 'E2E Cedar School', 'school', 'E2E-CEDAR',
          'active', true, now()
        )
      `;
      await sql`
        INSERT INTO oneroster_academic_sessions (
          sourced_id, title, type, status, is_active, last_synced_at
        )
        VALUES (
          ${termId}, 'E2E Fall Term', 'term', 'active', true, now()
        )
      `;
      await sql`
        INSERT INTO oneroster_classes (
          sourced_id, title, class_code, school_sourced_id, status,
          is_active, last_synced_at
        )
        VALUES (
          ${classId}, 'E2E Biology', 'BIO-E2E', ${schoolId}, 'active',
          true, now()
        )
      `;
      await sql`
        INSERT INTO oneroster_class_terms (
          class_sourced_id, term_sourced_id, status, is_active, last_synced_at
        )
        VALUES (${classId}, ${termId}, 'active', true, now())
      `;
      await sql`
        INSERT INTO oneroster_users (
          sourced_id, email, given_name, family_name, role, status,
          is_active, last_synced_at
        )
        VALUES
          (
            ${teacherId}, ${`teacher-${stamp}@psd401.net`}, 'Taylor', 'Teacher',
            'teacher', 'active', true, now()
          ),
          (
            ${studentId}, ${`student-${stamp}@edtools.psd401.net`}, 'Sam', 'Student',
            'student', 'active', true, now()
          )
      `;
      await sql`
        INSERT INTO oneroster_enrollments (
          sourced_id, user_sourced_id, class_sourced_id, school_sourced_id,
          role, is_primary, status, is_active, last_synced_at
        )
        VALUES
          (
            ${teacherEnrollmentId}, ${teacherId}, ${classId}, ${schoolId},
            'teacher', true, 'active', true, now()
          ),
          (
            ${studentEnrollmentId}, ${studentId}, ${classId}, ${schoolId},
            'student', true, 'active', true, now()
          )
      `;

      await authenticateContext(
        page.context(),
        SEEDED_ADMIN_EMAIL,
        SEEDED_ADMIN_SUB
      );
      await page.goto("/admin/rosters");
      await expect(
        page.locator("h1").filter({ hasText: /^Rosters$/ })
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("rosters-admin")).toBeVisible();

      await expect(page.getByTestId("roster-base-url")).toHaveValue(
        "https://district.example.org"
      );
      await page.getByTestId("roster-page-size").fill("4321");
      await page.getByTestId("roster-settings-save").click();
      await expect
        .poll(
          async () => {
            const [row] = await sql<{ value: string | null }[]>`
              SELECT value
              FROM settings
              WHERE key = 'ONEROSTER_PAGE_SIZE'
            `;
            return row?.value;
          },
          { timeout: 10_000 }
        )
        .toBe("4321");

      await page.getByTestId("tab-roster-sync").click();
      await expect(
        page.getByTestId("roster-collection-summary")
      ).toBeVisible();
      await expect(page.getByText("Organizations", { exact: true })).toBeVisible();
      await expect(page.getByTestId("roster-sync-now")).toBeEnabled();

      await page.getByTestId("tab-roster-browser").click();
      await page.getByTestId("roster-school-select").click();
      await page.getByRole("option", { name: "E2E Cedar School" }).click();
      await expect(page.getByTestId("roster-classes-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("E2E Biology", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Taylor Teacher", { exact: true })
      ).toBeVisible();
      await page.getByTestId(`view-roster-${classId}`).click();
      await expect(page.getByTestId("roster-students-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Sam Student", { exact: true })).toBeVisible();

      await mkdir(".verification", { recursive: true });
      await page.screenshot({
        path: `.verification/admin-rosters-${testInfo.project.name}.png`,
        fullPage: true,
      });
    } finally {
      await sql`
        DELETE FROM oneroster_enrollments
         WHERE sourced_id IN (${teacherEnrollmentId}, ${studentEnrollmentId})
      `;
      await sql`
        DELETE FROM oneroster_users
         WHERE sourced_id IN (${teacherId}, ${studentId})
      `;
      await sql`
        DELETE FROM oneroster_class_terms
         WHERE class_sourced_id = ${classId}
      `;
      await sql`
        DELETE FROM oneroster_classes
         WHERE sourced_id = ${classId}
      `;
      await sql`
        DELETE FROM oneroster_academic_sessions
         WHERE sourced_id = ${termId}
      `;
      await sql`
        DELETE FROM oneroster_orgs
         WHERE sourced_id = ${schoolId}
      `;
      await sql`
        DELETE FROM settings
         WHERE key IN ${sql([...settingKeys])}
      `;
      for (const row of originalSettings) {
        await sql`
          INSERT INTO settings (
            key, value, description, category, is_secret
          )
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
  });
});
