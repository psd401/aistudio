import { mkdir } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from "./helpers/session-auth";

async function connectRoomDatabase() {
  const postgres = (await import("postgres")).default;
  return postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" }
  );
}

type RoomDatabase = Awaited<ReturnType<typeof connectRoomDatabase>>;

interface RoomFixture {
  stamp: number;
  schoolId: string;
  otherSchoolId: string;
  linkedClassId: string;
  otherClassId: string;
  otherSchoolClassId: string;
  teacherRosterId: string;
  sectionStudentId: string;
  explicitStudentId: string;
  otherSchoolStudentId: string;
  teacherEnrollmentId: string;
  sectionStudentEnrollmentId: string;
  explicitStudentEnrollmentId: string;
  otherSchoolStudentEnrollmentId: string;
  explicitStudentEmail: string;
  otherSchoolStudentEmail: string;
  roomName: string;
}

function createRoomFixture(): RoomFixture {
  const stamp = Date.now();
  return {
    stamp,
    schoolId: `room-e2e-school-${stamp}`,
    otherSchoolId: `room-e2e-other-school-${stamp}`,
    linkedClassId: `room-e2e-linked-${stamp}`,
    otherClassId: `room-e2e-other-${stamp}`,
    otherSchoolClassId: `room-e2e-other-school-class-${stamp}`,
    teacherRosterId: `room-e2e-teacher-${stamp}`,
    sectionStudentId: `room-e2e-section-student-${stamp}`,
    explicitStudentId: `room-e2e-explicit-student-${stamp}`,
    otherSchoolStudentId: `room-e2e-other-school-student-${stamp}`,
    teacherEnrollmentId: `room-e2e-teacher-enrollment-${stamp}`,
    sectionStudentEnrollmentId:
      `room-e2e-section-student-enrollment-${stamp}`,
    explicitStudentEnrollmentId:
      `room-e2e-explicit-student-enrollment-${stamp}`,
    otherSchoolStudentEnrollmentId:
      `room-e2e-other-school-student-enrollment-${stamp}`,
    explicitStudentEmail: `explicit-${stamp}@edtools.psd401.net`,
    otherSchoolStudentEmail: `restricted-${stamp}@edtools.psd401.net`,
    roomName: `E2E Biology Room ${stamp}`,
  };
}

async function seedRosterFixture(
  sql: RoomDatabase,
  fixture: RoomFixture
): Promise<{ staffId: number; assistantId: number }> {
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
        ${fixture.schoolId}, 'E2E Room School', 'school', 'active', true, now()
      ),
      (
        ${fixture.otherSchoolId}, 'E2E Other School', 'school', 'active', true,
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
        ${fixture.linkedClassId}, 'E2E Biology Section', 'BIO-ROOM',
        ${fixture.schoolId}, 'active', true, now()
      ),
      (
        ${fixture.otherClassId}, 'E2E Other Section', 'OTHER-ROOM',
        ${fixture.schoolId}, 'active', true, now()
      ),
      (
        ${fixture.otherSchoolClassId}, 'E2E Restricted Section',
        'RESTRICTED-ROOM', ${fixture.otherSchoolId}, 'active', true, now()
      )
  `;
  await sql`
    INSERT INTO oneroster_users (
      sourced_id, email, given_name, family_name, role, status,
      is_active, last_synced_at
    )
    VALUES
      (
        ${fixture.teacherRosterId}, 'STAFF@EXAMPLE.COM', 'Staff', 'Member',
        'teacher', 'active', true, now()
      ),
      (
        ${fixture.sectionStudentId},
        ${`section-${fixture.stamp}@edtools.psd401.net`},
        'Section', 'Student', 'student', 'active', true, now()
      ),
      (
        ${fixture.explicitStudentId}, ${fixture.explicitStudentEmail},
        'Explicit', 'Student', 'student', 'active', true, now()
      ),
      (
        ${fixture.otherSchoolStudentId}, ${fixture.otherSchoolStudentEmail},
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
        ${fixture.teacherEnrollmentId}, ${fixture.teacherRosterId},
        ${fixture.linkedClassId}, ${fixture.schoolId}, 'teacher', 'active',
        true, now()
      ),
      (
        ${fixture.sectionStudentEnrollmentId}, ${fixture.sectionStudentId},
        ${fixture.linkedClassId}, ${fixture.schoolId}, 'student', 'active',
        true, now()
      ),
      (
        ${fixture.explicitStudentEnrollmentId}, ${fixture.explicitStudentId},
        ${fixture.otherClassId}, ${fixture.schoolId}, 'student', 'active',
        true, now()
      ),
      (
        ${fixture.otherSchoolStudentEnrollmentId},
        ${fixture.otherSchoolStudentId}, ${fixture.otherSchoolClassId},
        ${fixture.otherSchoolId}, 'student', 'active', true, now()
      )
  `;
  const [assistant] = await sql<{ id: number }[]>`
    INSERT INTO assistant_architects (
      name, description, status, user_id
    )
    VALUES (
      ${`E2E Room Assistant ${fixture.stamp}`},
      'Assistant assigned by the room-management functional test',
      'approved',
      ${staff.id}
    )
    RETURNING id
  `;
  if (!assistant) throw new Error("Assistant fixture was not created");
  return { staffId: staff.id, assistantId: assistant.id };
}

async function createRoomThroughUi(
  page: Page,
  fixture: RoomFixture,
  assistantId: number
): Promise<void> {
  await authenticateContext(
    page.context(),
    SEEDED_STAFF_EMAIL,
    SEEDED_STAFF_SUB
  );
  await page.goto("/dashboard");
  const navigation = page.getByRole("navigation");
  await navigation.hover();
  await navigation.getByRole("button", { name: "Instructional" }).click();
  const roomsLink = navigation.locator('a[href="/rooms/manage"]');
  await expect(roomsLink).toBeVisible({ timeout: 15_000 });
  await roomsLink.click();
  await expect(page.getByTestId("rooms-manage")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByTestId("room-name").fill(fixture.roomName);
  await page.getByTestId(`room-section-${fixture.linkedClassId}`).check();
  await page
    .getByTestId("room-student-search")
    .fill(`restricted-${fixture.stamp}`);
  await page.getByTestId("room-student-search-button").click();
  await expect(
    page.getByTestId(
      `room-student-result-${fixture.otherSchoolStudentEmail}`
    )
  ).toHaveCount(0);
  await page
    .getByTestId("room-student-search")
    .fill(`explicit-${fixture.stamp}`);
  await page.getByTestId("room-student-search-button").click();
  await page
    .getByTestId(`room-student-result-${fixture.explicitStudentEmail}`)
    .click();
  await page.getByTestId(`room-assistant-${assistantId}`).check();
  await page.getByTestId("room-save").click();

  await expect(page.getByTestId("room-feedback")).toContainText(
    "Room created",
    { timeout: 10_000 }
  );
  await expect(
    page.getByText(fixture.roomName, { exact: true })
  ).toBeVisible({ timeout: 10_000 });
}

async function verifyPersistedRoom(
  sql: RoomDatabase,
  fixture: RoomFixture,
  staffId: number,
  assistantId: number
): Promise<string> {
  const [createdRoom] = await sql<{ id: string }[]>`
    SELECT id
      FROM rooms
     WHERE name = ${fixture.roomName}
       AND created_by = ${staffId}
       AND is_active = true
  `;
  if (!createdRoom) throw new Error("Room was not persisted");
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
          AND lower(member_email) =
            lower(${fixture.explicitStudentEmail})) AS members,
      (SELECT count(*)::int FROM room_resources
        WHERE room_id = ${createdRoom.id}
          AND resource_type = 'assistant'
          AND resource_id = ${String(assistantId)}) AS resources
  `;
  expect(counts).toEqual({ classes: 1, members: 1, resources: 1 });
  return createdRoom.id;
}

async function verifyAdministratorVisibility(
  page: Page,
  roomName: string
): Promise<void> {
  await authenticateContext(page.context());
  await page.goto("/rooms/manage");
  await expect(page.getByText("All rooms", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(roomName, { exact: true })).toBeVisible();
}

async function cleanRoomFixture(
  sql: RoomDatabase,
  fixture: RoomFixture,
  roomId: string | null,
  assistantId: number | null
): Promise<void> {
  if (roomId) await sql`DELETE FROM rooms WHERE id = ${roomId}`;
  if (assistantId) {
    await sql`
      DELETE FROM assistant_architects WHERE id = ${assistantId}
    `;
  }
  await sql`
    DELETE FROM oneroster_enrollments
     WHERE sourced_id IN (
       ${fixture.teacherEnrollmentId},
       ${fixture.sectionStudentEnrollmentId},
       ${fixture.explicitStudentEnrollmentId},
       ${fixture.otherSchoolStudentEnrollmentId}
     )
  `;
  await sql`
    DELETE FROM oneroster_users
     WHERE sourced_id IN (
       ${fixture.teacherRosterId}, ${fixture.sectionStudentId},
       ${fixture.explicitStudentId}, ${fixture.otherSchoolStudentId}
     )
  `;
  await sql`
    DELETE FROM oneroster_classes
     WHERE sourced_id IN (
       ${fixture.linkedClassId}, ${fixture.otherClassId},
       ${fixture.otherSchoolClassId}
     )
  `;
  await sql`
    DELETE FROM oneroster_orgs
     WHERE sourced_id IN (${fixture.schoolId}, ${fixture.otherSchoolId})
  `;
}

async function teacherCreatesManagedRoom(
  { page }: { page: Page },
  testInfo: TestInfo
): Promise<void> {
  const sql = await connectRoomDatabase();
  const fixture = createRoomFixture();
  let roomId: string | null = null;
  let assistantId: number | null = null;
  try {
    const seeded = await seedRosterFixture(sql, fixture);
    assistantId = seeded.assistantId;
    await createRoomThroughUi(page, fixture, seeded.assistantId);
    roomId = await verifyPersistedRoom(
      sql,
      fixture,
      seeded.staffId,
      seeded.assistantId
    );
    await verifyAdministratorVisibility(page, fixture.roomName);
    await mkdir(".verification", { recursive: true });
    await page.screenshot({
      path: `.verification/teacher-room-create-${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await cleanRoomFixture(sql, fixture, roomId, assistantId);
    await sql.end();
  }
}

test.describe("Teacher room management (#1313)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host dev server"
  );
  test(
    "teacher composes a section, explicit student, and accessible assistant",
    teacherCreatesManagedRoom
  );
});
