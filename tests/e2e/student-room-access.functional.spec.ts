import { mkdir } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import type postgres from "postgres";
import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from "./helpers/session-auth";

type TestDatabase = postgres.Sql;

interface StudentRoomNames {
  classId: string;
  rosterUserId: string;
  enrollmentId: string;
  explicitRoomName: string;
  sectionRoomName: string;
  assignedName: string;
  hiddenName: string;
}

interface StudentRoomCleanupTargets {
  explicitRoomId: string | null;
  sectionRoomId: string | null;
  assignedAssistantId: number | null;
  hiddenAssistantId: number | null;
}

interface StudentRoomFixture extends StudentRoomNames {
  explicitRoomId: string;
  sectionRoomId: string;
  assignedAssistantId: number;
  hiddenAssistantId: number;
}

function createStudentRoomNames(stamp: number): StudentRoomNames {
  return {
    classId: `student-room-class-${stamp}`,
    rosterUserId: `student-room-user-${stamp}`,
    enrollmentId: `student-room-enrollment-${stamp}`,
    explicitRoomName: `E2E Advisory Room ${stamp}`,
    sectionRoomName: `E2E Biology Room ${stamp}`,
    assignedName: `E2E Assigned Room Assistant ${stamp}`,
    hiddenName: `E2E Hidden Assistant ${stamp}`,
  };
}

async function loadSeededRoomUsers(
  sql: TestDatabase
): Promise<{ studentEmail: string; staffId: number }> {
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
  return { studentEmail: student.email, staffId: staff.id };
}

async function createAssistantFixtures(
  sql: TestDatabase,
  names: StudentRoomNames,
  staffId: number,
  targets: StudentRoomCleanupTargets
): Promise<{ assignedAssistantId: number; hiddenAssistantId: number }> {
  const [assignedAssistant] = await sql<{ id: number }[]>`
    INSERT INTO assistant_architects (
      name, description, status, user_id
    )
    VALUES (
      ${names.assignedName},
      'Room-assigned assistant for the student functional test',
      'approved',
      ${staffId}
    )
    RETURNING id
  `;
  if (!assignedAssistant) {
    throw new Error("Assigned assistant fixture was not created");
  }
  targets.assignedAssistantId = assignedAssistant.id;

  const [hiddenAssistant] = await sql<{ id: number }[]>`
    INSERT INTO assistant_architects (
      name, description, status, user_id
    )
    VALUES (
      ${names.hiddenName},
      'Unassigned assistant hidden from room-restricted students',
      'approved',
      ${staffId}
    )
    RETURNING id
  `;
  if (!hiddenAssistant) {
    throw new Error("Hidden assistant fixture was not created");
  }
  targets.hiddenAssistantId = hiddenAssistant.id;
  return {
    assignedAssistantId: assignedAssistant.id,
    hiddenAssistantId: hiddenAssistant.id,
  };
}

async function createRoomFixtures(
  sql: TestDatabase,
  names: StudentRoomNames,
  staffId: number,
  targets: StudentRoomCleanupTargets
): Promise<{ explicitRoomId: string; sectionRoomId: string }> {
  const [explicitRoom] = await sql<{ id: string }[]>`
    INSERT INTO rooms (name, created_by)
    VALUES (${names.explicitRoomName}, ${staffId})
    RETURNING id
  `;
  if (!explicitRoom) throw new Error("Explicit room fixture was not created");
  targets.explicitRoomId = explicitRoom.id;

  const [sectionRoom] = await sql<{ id: string }[]>`
    INSERT INTO rooms (name, created_by)
    VALUES (${names.sectionRoomName}, ${staffId})
    RETURNING id
  `;
  if (!sectionRoom) throw new Error("Section room fixture was not created");
  targets.sectionRoomId = sectionRoom.id;
  return {
    explicitRoomId: explicitRoom.id,
    sectionRoomId: sectionRoom.id,
  };
}

async function bindExplicitRoom(
  sql: TestDatabase,
  studentEmail: string,
  staffId: number,
  explicitRoomId: string,
  assignedAssistantId: number
): Promise<void> {
  await sql`
    INSERT INTO room_members (room_id, member_email)
    VALUES (${explicitRoomId}, ${studentEmail.toLowerCase()})
  `;
  await sql`
    INSERT INTO room_resources (room_id, resource_type, resource_id)
    VALUES (${explicitRoomId}, 'assistant', ${String(assignedAssistantId)})
  `;
  // A denying ordinary grant proves room assignment is the access path.
  await sql`
    INSERT INTO resource_access_grants (
      resource_type, resource_id, grant_kind, grant_value, created_by
    )
    VALUES (
      'assistant',
      ${String(assignedAssistantId)},
      'role',
      'no-such-role',
      ${staffId}
    )
  `;
}

async function bindSectionRoom(
  sql: TestDatabase,
  names: StudentRoomNames,
  studentEmail: string,
  sectionRoomId: string
): Promise<void> {
  await sql`
    INSERT INTO oneroster_classes (
      sourced_id, title, class_code, status, is_active, last_synced_at
    )
    VALUES (
      ${names.classId},
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
      ${names.rosterUserId},
      ${studentEmail.toUpperCase()},
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
      ${names.enrollmentId},
      ${names.rosterUserId},
      ${names.classId},
      'student',
      'active',
      true,
      now()
    )
  `;
  await sql`
    INSERT INTO room_classes (room_id, class_sourced_id)
    VALUES (${sectionRoomId}, ${names.classId})
  `;
}

async function createStudentRoomFixture(
  sql: TestDatabase,
  names: StudentRoomNames,
  targets: StudentRoomCleanupTargets
): Promise<StudentRoomFixture> {
  const { studentEmail, staffId } = await loadSeededRoomUsers(sql);
  const assistants = await createAssistantFixtures(
    sql,
    names,
    staffId,
    targets
  );
  const rooms = await createRoomFixtures(sql, names, staffId, targets);
  await bindExplicitRoom(
    sql,
    studentEmail,
    staffId,
    rooms.explicitRoomId,
    assistants.assignedAssistantId
  );
  await bindSectionRoom(sql, names, studentEmail, rooms.sectionRoomId);
  return { ...names, ...assistants, ...rooms };
}

async function verifyStudentRooms(
  page: Page,
  fixture: StudentRoomFixture,
  testInfo: TestInfo
): Promise<void> {
  await authenticateContext(
    page.context(),
    SEEDED_NO_CAPABILITY_EMAIL,
    SEEDED_NO_CAPABILITY_SUB
  );
  await page.goto("/dashboard");
  const navigation = page.getByRole("navigation");
  await navigation.hover();
  await navigation.getByRole("button", { name: "Instructional" }).click();
  const myRoomsLink = navigation.locator('a[href="/rooms"]');
  await expect(myRoomsLink).toBeVisible({ timeout: 15_000 });
  await expect(navigation.locator('a[href="/rooms/manage"]')).toHaveCount(0);
  await myRoomsLink.click();

  await expect(page.getByTestId("student-rooms-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText(fixture.explicitRoomName, { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(fixture.sectionRoomName, { exact: true })
  ).toBeVisible();

  await page.locator(`a[href="/rooms/${fixture.explicitRoomId}"]`).click();
  await expect(page.getByTestId("student-room-detail")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText(fixture.assignedName, { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(fixture.hiddenName, { exact: true })
  ).toHaveCount(0);
  await expect(page.getByText("Loading", { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });

  await mkdir(".verification", { recursive: true });
  await page.screenshot({
    path: `.verification/student-room-access-${testInfo.project.name}.png`,
    fullPage: true,
  });
}

async function verifyAssistantVisibility(
  page: Page,
  fixture: StudentRoomFixture
): Promise<void> {
  await page.goto("/utilities/assistant-catalog");
  await expect(
    page.getByRole("heading", { name: fixture.assignedName })
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: fixture.hiddenName })
  ).toHaveCount(0);

  const hiddenResponse = await page.goto(
    `/tools/assistant-architect/${fixture.hiddenAssistantId}`
  );
  expect(hiddenResponse?.status()).toBe(404);

  const launchResponse = await page.goto(
    `/tools/assistant-architect/${fixture.assignedAssistantId}`
  );
  expect(launchResponse?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: fixture.assignedName })
  ).toBeVisible({ timeout: 15_000 });
}

async function verifyAssistantExecutionBoundary(
  page: Page,
  fixture: StudentRoomFixture
): Promise<void> {
  // The assigned fixture has no prompts, so reaching prompt validation proves
  // room-backed authorization passed. The former bug returned 403 first.
  const assignedExecution = await page.request.post(
    "/api/assistant-architect/execute",
    {
      data: {
        toolId: fixture.assignedAssistantId,
        inputs: {},
      },
    }
  );
  expect(assignedExecution.status()).toBe(400);
  await expect(assignedExecution.json()).resolves.toEqual(
    expect.objectContaining({
      error: "No prompts configured for this assistant architect",
    })
  );

  const hiddenExecution = await page.request.post(
    "/api/assistant-architect/execute",
    {
      data: {
        toolId: fixture.hiddenAssistantId,
        inputs: {},
      },
    }
  );
  expect(hiddenExecution.status()).toBe(403);
}

async function cleanStudentRoomFixture(
  sql: TestDatabase,
  names: StudentRoomNames,
  targets: StudentRoomCleanupTargets
): Promise<void> {
  if (targets.assignedAssistantId !== null) {
    await sql`
      DELETE FROM resource_access_grants
       WHERE resource_type = 'assistant'
         AND resource_id = ${String(targets.assignedAssistantId)}
    `;
  }
  if (targets.explicitRoomId !== null || targets.sectionRoomId !== null) {
    await sql`
      DELETE FROM rooms
       WHERE id IN (
         ${targets.explicitRoomId ??
         "00000000-0000-0000-0000-000000000000"},
         ${targets.sectionRoomId ??
         "00000000-0000-0000-0000-000000000000"}
       )
    `;
  }
  await sql`
    DELETE FROM oneroster_enrollments WHERE sourced_id = ${names.enrollmentId}
  `;
  await sql`
    DELETE FROM oneroster_users WHERE sourced_id = ${names.rosterUserId}
  `;
  await sql`
    DELETE FROM oneroster_classes WHERE sourced_id = ${names.classId}
  `;
  if (
    targets.assignedAssistantId !== null ||
    targets.hiddenAssistantId !== null
  ) {
    await sql`
      DELETE FROM assistant_architects
       WHERE id IN (
         ${targets.assignedAssistantId ?? -1},
         ${targets.hiddenAssistantId ?? -1}
       )
    `;
  }
  await sql.end();
}

async function runStudentRoomAccessTest(
  { page }: { page: Page },
  testInfo: TestInfo
): Promise<void> {
  const postgresClient = (await import("postgres")).default;
  const sql = postgresClient(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" }
  );
  const names = createStudentRoomNames(Date.now());
  const targets: StudentRoomCleanupTargets = {
    explicitRoomId: null,
    sectionRoomId: null,
    assignedAssistantId: null,
    hiddenAssistantId: null,
  };

  try {
    const fixture = await createStudentRoomFixture(sql, names, targets);
    await verifyStudentRooms(page, fixture, testInfo);
    await verifyAssistantVisibility(page, fixture);
    await verifyAssistantExecutionBoundary(page, fixture);
  } finally {
    await cleanStudentRoomFixture(sql, names, targets);
  }
}

function defineStudentRoomAccessSuite(): void {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host dev server"
  );
  test(
    "student sees explicit/section rooms and launches only an assigned assistant",
    runStudentRoomAccessTest
  );
}

test.describe("Student room access (#1314)", defineStudentRoomAccessSuite);
