import { mkdir } from "node:fs/promises";
import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from "./helpers/session-auth";

test.describe("Student room access (#1314)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host dev server"
  );

  test("student sees explicit/section rooms and launches only an assigned assistant", async ({
    page,
  }, testInfo) => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(
      process.env.E2E_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/aistudio",
      { ssl: process.env.E2E_DB_SSL === "true" }
    );
    const stamp = Date.now();
    const classId = `student-room-class-${stamp}`;
    const rosterUserId = `student-room-user-${stamp}`;
    const enrollmentId = `student-room-enrollment-${stamp}`;
    const explicitRoomName = `E2E Advisory Room ${stamp}`;
    const sectionRoomName = `E2E Biology Room ${stamp}`;
    const assignedName = `E2E Assigned Room Assistant ${stamp}`;
    const hiddenName = `E2E Hidden Assistant ${stamp}`;
    let explicitRoomId: string | null = null;
    let sectionRoomId: string | null = null;
    let assignedAssistantId: number | null = null;
    let hiddenAssistantId: number | null = null;

    try {
      const [student] = await sql<{ id: number; email: string }[]>`
        SELECT id, email
          FROM users
         WHERE cognito_sub = ${SEEDED_NO_CAPABILITY_SUB}
      `;
      const [staff] = await sql<{ id: number }[]>`
        SELECT id
          FROM users
         WHERE cognito_sub = 'e2e-staff-user'
      `;
      if (!student?.email) throw new Error("Seeded student user is missing");
      if (!staff) throw new Error("Seeded staff user is missing");

      const [assignedAssistant] = await sql<{ id: number }[]>`
        INSERT INTO assistant_architects (
          name, description, status, user_id
        )
        VALUES (
          ${assignedName},
          'Room-assigned assistant for the student functional test',
          'approved',
          ${staff.id}
        )
        RETURNING id
      `;
      const [hiddenAssistant] = await sql<{ id: number }[]>`
        INSERT INTO assistant_architects (
          name, description, status, user_id
        )
        VALUES (
          ${hiddenName},
          'Unassigned assistant hidden from room-restricted students',
          'approved',
          ${staff.id}
        )
        RETURNING id
      `;
      if (!assignedAssistant || !hiddenAssistant) {
        throw new Error("Assistant fixtures were not created");
      }
      assignedAssistantId = assignedAssistant.id;
      hiddenAssistantId = hiddenAssistant.id;

      const [explicitRoom] = await sql<{ id: string }[]>`
        INSERT INTO rooms (name, created_by)
        VALUES (${explicitRoomName}, ${staff.id})
        RETURNING id
      `;
      const [sectionRoom] = await sql<{ id: string }[]>`
        INSERT INTO rooms (name, created_by)
        VALUES (${sectionRoomName}, ${staff.id})
        RETURNING id
      `;
      if (!explicitRoom || !sectionRoom) {
        throw new Error("Room fixtures were not created");
      }
      explicitRoomId = explicitRoom.id;
      sectionRoomId = sectionRoom.id;

      await sql`
        INSERT INTO room_members (room_id, member_email)
        VALUES (${explicitRoom.id}, ${student.email.toLowerCase()})
      `;
      await sql`
        INSERT INTO room_resources (room_id, resource_type, resource_id)
        VALUES (
          ${explicitRoom.id},
          'assistant',
          ${String(assignedAssistant.id)}
        )
      `;
      // A denying ordinary grant proves room assignment is the access path.
      await sql`
        INSERT INTO resource_access_grants (
          resource_type, resource_id, grant_kind, grant_value, created_by
        )
        VALUES (
          'assistant',
          ${String(assignedAssistant.id)},
          'role',
          'no-such-role',
          ${staff.id}
        )
      `;

      await sql`
        INSERT INTO oneroster_classes (
          sourced_id, title, class_code, status, is_active, last_synced_at
        )
        VALUES (
          ${classId},
          'E2E Student Room Biology',
          'STUDENT-ROOM',
          'active',
          true,
          now()
        )
      `;
      await sql`
        INSERT INTO oneroster_users (
          sourced_id, email, given_name, family_name, role, status,
          is_active, last_synced_at
        )
        VALUES (
          ${rosterUserId},
          ${student.email.toUpperCase()},
          'Student',
          'Room',
          'student',
          'active',
          true,
          now()
        )
      `;
      await sql`
        INSERT INTO oneroster_enrollments (
          sourced_id, user_sourced_id, class_sourced_id, role, status,
          is_active, last_synced_at
        )
        VALUES (
          ${enrollmentId},
          ${rosterUserId},
          ${classId},
          'student',
          'active',
          true,
          now()
        )
      `;
      await sql`
        INSERT INTO room_classes (room_id, class_sourced_id)
        VALUES (${sectionRoom.id}, ${classId})
      `;

      await authenticateContext(
        page.context(),
        SEEDED_NO_CAPABILITY_EMAIL,
        SEEDED_NO_CAPABILITY_SUB
      );
      await page.goto("/dashboard");
      const navigation = page.getByRole("navigation");
      await navigation.hover();
      await navigation
        .getByRole("button", { name: "Instructional" })
        .click();
      const myRoomsLink = navigation.locator('a[href="/rooms"]');
      await expect(myRoomsLink).toBeVisible({ timeout: 15_000 });
      await expect(
        navigation.locator('a[href="/rooms/manage"]')
      ).toHaveCount(0);
      await myRoomsLink.click();

      await expect(page.getByTestId("student-rooms-page")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(explicitRoomName, { exact: true })
      ).toBeVisible();
      await expect(
        page.getByText(sectionRoomName, { exact: true })
      ).toBeVisible();

      await page.locator(`a[href="/rooms/${explicitRoom.id}"]`).click();
      await expect(page.getByTestId("student-room-detail")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(assignedName, { exact: true })
      ).toBeVisible();
      await expect(page.getByText(hiddenName, { exact: true })).toHaveCount(0);
      await expect(
        page.getByText("Loading", { exact: true })
      ).toHaveCount(0, { timeout: 15_000 });

      await mkdir(".verification", { recursive: true });
      await page.screenshot({
        path: `.verification/student-room-access-${testInfo.project.name}.png`,
        fullPage: true,
      });

      await page.goto("/utilities/assistant-catalog");
      await expect(
        page.getByRole("heading", { name: assignedName })
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole("heading", { name: hiddenName })
      ).toHaveCount(0);

      const hiddenResponse = await page.goto(
        `/tools/assistant-architect/${hiddenAssistant.id}`
      );
      expect(hiddenResponse?.status()).toBe(404);

      const launchResponse = await page.goto(
        `/tools/assistant-architect/${assignedAssistant.id}`
      );
      expect(launchResponse?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { name: assignedName })
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      if (assignedAssistantId !== null) {
        await sql`
          DELETE FROM resource_access_grants
           WHERE resource_type = 'assistant'
             AND resource_id = ${String(assignedAssistantId)}
        `;
      }
      if (explicitRoomId !== null || sectionRoomId !== null) {
        await sql`
          DELETE FROM rooms
           WHERE id IN (
             ${explicitRoomId ??
             "00000000-0000-0000-0000-000000000000"},
             ${sectionRoomId ??
             "00000000-0000-0000-0000-000000000000"}
           )
        `;
      }
      await sql`
        DELETE FROM oneroster_enrollments WHERE sourced_id = ${enrollmentId}
      `;
      await sql`
        DELETE FROM oneroster_users WHERE sourced_id = ${rosterUserId}
      `;
      await sql`
        DELETE FROM oneroster_classes WHERE sourced_id = ${classId}
      `;
      if (assignedAssistantId !== null || hiddenAssistantId !== null) {
        await sql`
          DELETE FROM assistant_architects
           WHERE id IN (
             ${assignedAssistantId ?? -1},
             ${hiddenAssistantId ?? -1}
           )
        `;
      }
      await sql.end();
    }
  });
});
