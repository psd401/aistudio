import { mkdir } from "node:fs/promises";
import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from "./helpers/session-auth";

test.describe("Teacher room management (#1313)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host dev server"
  );

  test("teacher composes a section, explicit student, and accessible assistant", async ({
    page,
  }, testInfo) => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(
      process.env.E2E_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/aistudio",
      { ssl: process.env.E2E_DB_SSL === "true" }
    );
    const stamp = Date.now();
    const schoolId = `room-e2e-school-${stamp}`;
    const otherSchoolId = `room-e2e-other-school-${stamp}`;
    const linkedClassId = `room-e2e-linked-${stamp}`;
    const otherClassId = `room-e2e-other-${stamp}`;
    const otherSchoolClassId = `room-e2e-other-school-class-${stamp}`;
    const teacherRosterId = `room-e2e-teacher-${stamp}`;
    const sectionStudentId = `room-e2e-section-student-${stamp}`;
    const explicitStudentId = `room-e2e-explicit-student-${stamp}`;
    const otherSchoolStudentId = `room-e2e-other-school-student-${stamp}`;
    const teacherEnrollmentId = `room-e2e-teacher-enrollment-${stamp}`;
    const sectionStudentEnrollmentId =
      `room-e2e-section-student-enrollment-${stamp}`;
    const explicitStudentEnrollmentId =
      `room-e2e-explicit-student-enrollment-${stamp}`;
    const otherSchoolStudentEnrollmentId =
      `room-e2e-other-school-student-enrollment-${stamp}`;
    const explicitStudentEmail =
      `explicit-${stamp}@edtools.psd401.net`;
    const otherSchoolStudentEmail =
      `restricted-${stamp}@edtools.psd401.net`;
    const roomName = `E2E Biology Room ${stamp}`;
    let roomId: string | null = null;
    let assistantId: number | null = null;

    try {
      const [staff] = await sql<{ id: number }[]>`
        SELECT id FROM users WHERE cognito_sub = ${SEEDED_STAFF_SUB}
      `;
      if (!staff) throw new Error("Seeded staff user is missing");

      await sql`
        INSERT INTO oneroster_orgs (
          sourced_id, name, type, status, is_active, last_synced_at
        )
        VALUES
          (
            ${schoolId}, 'E2E Room School', 'school', 'active', true, now()
          ),
          (
            ${otherSchoolId}, 'E2E Other School', 'school', 'active', true,
            now()
          )
      `;
      await sql`
        INSERT INTO oneroster_classes (
          sourced_id, title, class_code, school_sourced_id, status,
          is_active, last_synced_at
        )
        VALUES
          (
            ${linkedClassId}, 'E2E Biology Section', 'BIO-ROOM',
            ${schoolId}, 'active', true, now()
          ),
          (
            ${otherClassId}, 'E2E Other Section', 'OTHER-ROOM',
            ${schoolId}, 'active', true, now()
          ),
          (
            ${otherSchoolClassId}, 'E2E Restricted Section',
            'RESTRICTED-ROOM', ${otherSchoolId}, 'active', true, now()
          )
      `;
      await sql`
        INSERT INTO oneroster_users (
          sourced_id, email, given_name, family_name, role, status,
          is_active, last_synced_at
        )
        VALUES
          (
            ${teacherRosterId}, 'STAFF@EXAMPLE.COM', 'Staff', 'Member',
            'teacher', 'active', true, now()
          ),
          (
            ${sectionStudentId},
            ${`section-${stamp}@edtools.psd401.net`},
            'Section', 'Student', 'student', 'active', true, now()
          ),
          (
            ${explicitStudentId}, ${explicitStudentEmail},
            'Explicit', 'Student', 'student', 'active', true, now()
          ),
          (
            ${otherSchoolStudentId}, ${otherSchoolStudentEmail},
            'Restricted', 'Student', 'student', 'active', true, now()
          )
      `;
      await sql`
        INSERT INTO oneroster_enrollments (
          sourced_id, user_sourced_id, class_sourced_id, school_sourced_id,
          role, status, is_active, last_synced_at
        )
        VALUES
          (
            ${teacherEnrollmentId}, ${teacherRosterId}, ${linkedClassId},
            ${schoolId}, 'teacher', 'active', true, now()
          ),
          (
            ${sectionStudentEnrollmentId}, ${sectionStudentId},
            ${linkedClassId}, ${schoolId}, 'student', 'active', true, now()
          ),
          (
            ${explicitStudentEnrollmentId}, ${explicitStudentId},
            ${otherClassId}, ${schoolId}, 'student', 'active', true, now()
          ),
          (
            ${otherSchoolStudentEnrollmentId}, ${otherSchoolStudentId},
            ${otherSchoolClassId}, ${otherSchoolId}, 'student', 'active',
            true, now()
          )
      `;
      const [assistant] = await sql<{ id: number }[]>`
        INSERT INTO assistant_architects (
          name, description, status, user_id
        )
        VALUES (
          ${`E2E Room Assistant ${stamp}`},
          'Assistant assigned by the room-management functional test',
          'approved',
          ${staff.id}
        )
        RETURNING id
      `;
      if (!assistant) throw new Error("Assistant fixture was not created");
      assistantId = assistant.id;

      await authenticateContext(
        page.context(),
        SEEDED_STAFF_EMAIL,
        SEEDED_STAFF_SUB
      );
      await page.goto("/dashboard");
      const navigation = page.getByRole("navigation");
      await navigation.hover();
      await navigation
        .getByRole("button", { name: "Instructional" })
        .click();
      const roomsLink = navigation.locator('a[href="/rooms/manage"]');
      await expect(roomsLink).toBeVisible({ timeout: 15_000 });
      await roomsLink.click();
      await expect(page.getByTestId("rooms-manage")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByTestId("room-name").fill(roomName);
      await page
        .getByTestId(`room-section-${linkedClassId}`)
        .check();
      await page
        .getByTestId("room-student-search")
        .fill(`restricted-${stamp}`);
      await page.getByTestId("room-student-search-button").click();
      await expect(
        page.getByTestId(
          `room-student-result-${otherSchoolStudentEmail}`
        )
      ).toHaveCount(0);
      await page
        .getByTestId("room-student-search")
        .fill(`explicit-${stamp}`);
      await page.getByTestId("room-student-search-button").click();
      await page
        .getByTestId(`room-student-result-${explicitStudentEmail}`)
        .click();
      await page
        .getByTestId(`room-assistant-${assistant.id}`)
        .check();
      await page.getByTestId("room-save").click();

      await expect(page.getByTestId("room-feedback")).toContainText(
        "Room created",
        { timeout: 10_000 }
      );
      await expect(page.getByText(roomName, { exact: true })).toBeVisible({
        timeout: 10_000,
      });

      const [createdRoom] = await sql<{ id: string }[]>`
        SELECT id
          FROM rooms
         WHERE name = ${roomName}
           AND created_by = ${staff.id}
           AND is_active = true
      `;
      if (!createdRoom) throw new Error("Room was not persisted");
      roomId = createdRoom.id;
      const [counts] = await sql<{
        classes: number;
        members: number;
        resources: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM room_classes
            WHERE room_id = ${createdRoom.id}) AS classes,
          (SELECT count(*)::int FROM room_members
            WHERE room_id = ${createdRoom.id}
              AND lower(member_email) = lower(${explicitStudentEmail})) AS members,
          (SELECT count(*)::int FROM room_resources
            WHERE room_id = ${createdRoom.id}
              AND resource_type = 'assistant'
              AND resource_id = ${String(assistant.id)}) AS resources
      `;
      expect(counts).toEqual({ classes: 1, members: 1, resources: 1 });

      await authenticateContext(page.context());
      await page.goto("/rooms/manage");
      await expect(page.getByText("All rooms", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(roomName, { exact: true })).toBeVisible();

      await mkdir(".verification", { recursive: true });
      await page.screenshot({
        path: `.verification/teacher-room-create-${testInfo.project.name}.png`,
        fullPage: true,
      });
    } finally {
      if (roomId) {
        await sql`DELETE FROM rooms WHERE id = ${roomId}`;
      }
      if (assistantId) {
        await sql`
          DELETE FROM assistant_architects WHERE id = ${assistantId}
        `;
      }
      await sql`
        DELETE FROM oneroster_enrollments
         WHERE sourced_id IN (
           ${teacherEnrollmentId},
           ${sectionStudentEnrollmentId},
           ${explicitStudentEnrollmentId},
           ${otherSchoolStudentEnrollmentId}
         )
      `;
      await sql`
        DELETE FROM oneroster_users
         WHERE sourced_id IN (
           ${teacherRosterId}, ${sectionStudentId}, ${explicitStudentId},
           ${otherSchoolStudentId}
         )
      `;
      await sql`
        DELETE FROM oneroster_classes
         WHERE sourced_id IN (
           ${linkedClassId}, ${otherClassId}, ${otherSchoolClassId}
         )
      `;
      await sql`
        DELETE FROM oneroster_orgs
         WHERE sourced_id IN (${schoolId}, ${otherSchoolId})
      `;
      await sql.end();
    }
  });
});
