/**
 * Room assistant authorization smoke (Epic #1308 / Issue #1314).
 *
 * Proves the shared single/batch gates against PostgreSQL:
 * - explicit and section membership reverse lookup
 * - room assignment overrides a denying resource_access_grant
 * - student-only room members are restricted to assigned assistants
 * - staff/admin are never room-restricted
 * - a student with no active room keeps ordinary access
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' \
 *   DB_SSL=false bun run tests/smoke/room-assistant-access.smoke.ts
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import {
  deleteAllResourceGrants,
  filterAccessibleResourceIds,
  replaceResourceGrants,
  userCanAccessResource,
} from "@/lib/db/drizzle/resource-access";
import {
  getRoomAssistantAccessContext,
  roomForUser,
  roomsForUser,
} from "@/lib/rooms/membership";
import { createLogger } from "@/lib/logger";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const db = postgres(databaseUrl, { ssl: process.env.DB_SSL === "true" });
const log = createLogger({ action: "roomAssistantAccessSmoke" });
const stamp = Date.now();
const noRoomSub = `room-smoke-no-room-${stamp}`;
const noRoomEmail = `room-smoke-no-room-${stamp}@example.com`;
const explicitRoomName = `Room Smoke Explicit ${stamp}`;
const sectionRoomName = `Room Smoke Section ${stamp}`;
const classId = `room-smoke-class-${stamp}`;
const rosterUserId = `room-smoke-user-${stamp}`;
const enrollmentId = `room-smoke-enrollment-${stamp}`;

let assignedAssistantId: number | null = null;
let unassignedAssistantId: number | null = null;
let explicitRoomId: string | null = null;
let sectionRoomId: string | null = null;
let noRoomStudentId: number | null = null;
let passed = 0;

async function check(
  name: string,
  fn: () => Promise<void> | void
): Promise<void> {
  await fn();
  passed += 1;
  log.info("Smoke check passed", { name });
}

try {
  const [student] = await db<{ id: number; email: string }[]>`
    SELECT id, email
      FROM users
     WHERE cognito_sub = 'e2e-student-user'
  `;
  const [staff] = await db<{ id: number; email: string }[]>`
    SELECT id, email
      FROM users
     WHERE cognito_sub = 'e2e-staff-user'
  `;
  const [admin] = await db<{ id: number }[]>`
    SELECT id
      FROM users
     WHERE cognito_sub = 'e2e-test-user'
  `;
  assert.ok(student?.email, "seed missing: e2e student");
  assert.ok(staff?.email, "seed missing: e2e staff");
  assert.ok(admin, "seed missing: e2e administrator");

  const [noRoomStudent] = await db<{ id: number }[]>`
    INSERT INTO users (cognito_sub, email, first_name, last_name)
    VALUES (
      ${noRoomSub}, ${noRoomEmail}, 'No Room', 'Student'
    )
    RETURNING id
  `;
  assert.ok(noRoomStudent);
  noRoomStudentId = noRoomStudent.id;
  await db`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${noRoomStudent.id}, id
      FROM roles
     WHERE lower(name) = 'student'
  `;

  const [assignedAssistant] = await db<{ id: number }[]>`
    INSERT INTO assistant_architects (name, description, status, user_id)
    VALUES (
      ${`Room Smoke Assigned ${stamp}`},
      'Assigned room authorization smoke fixture',
      'approved',
      ${staff.id}
    )
    RETURNING id
  `;
  const [unassignedAssistant] = await db<{ id: number }[]>`
    INSERT INTO assistant_architects (name, description, status, user_id)
    VALUES (
      ${`Room Smoke Unassigned ${stamp}`},
      'Unassigned room authorization smoke fixture',
      'approved',
      ${staff.id}
    )
    RETURNING id
  `;
  assert.ok(assignedAssistant);
  assert.ok(unassignedAssistant);
  assignedAssistantId = assignedAssistant.id;
  unassignedAssistantId = unassignedAssistant.id;

  const [explicitRoom] = await db<{ id: string }[]>`
    INSERT INTO rooms (name, created_by)
    VALUES (${explicitRoomName}, ${staff.id})
    RETURNING id
  `;
  assert.ok(explicitRoom);
  explicitRoomId = explicitRoom.id;
  await db`
    INSERT INTO room_members (room_id, member_email)
    VALUES
      (${explicitRoom.id}, ${student.email.toLowerCase()}),
      (${explicitRoom.id}, ${staff.email.toLowerCase()})
  `;
  await db`
    INSERT INTO room_resources (room_id, resource_type, resource_id)
    VALUES (
      ${explicitRoom.id}, 'assistant', ${String(assignedAssistant.id)}
    )
  `;

  const [sectionRoom] = await db<{ id: string }[]>`
    INSERT INTO rooms (name, created_by)
    VALUES (${sectionRoomName}, ${staff.id})
    RETURNING id
  `;
  assert.ok(sectionRoom);
  sectionRoomId = sectionRoom.id;
  await db`
    INSERT INTO oneroster_classes (
      sourced_id, title, class_code, status, is_active, last_synced_at
    )
    VALUES (
      ${classId}, 'Room Smoke Section', 'ROOM-SMOKE', 'active', true, now()
    )
  `;
  await db`
    INSERT INTO oneroster_users (
      sourced_id, email, given_name, family_name, role, status,
      is_active, last_synced_at
    )
    VALUES (
      ${rosterUserId}, ${student.email.toUpperCase()}, 'Room', 'Student',
      'student', 'active', true, now()
    )
  `;
  await db`
    INSERT INTO oneroster_enrollments (
      sourced_id, user_sourced_id, class_sourced_id, role, status,
      is_active, last_synced_at
    )
    VALUES (
      ${enrollmentId}, ${rosterUserId}, ${classId}, 'student', 'active',
      true, now()
    )
  `;
  await db`
    INSERT INTO room_classes (room_id, class_sourced_id)
    VALUES (${sectionRoom.id}, ${classId})
  `;

  await replaceResourceGrants(
    "assistant",
    assignedAssistant.id,
    [{ grantKind: "role", grantValue: "no-such-role" }],
    admin.id
  );

  await check("reverse lookup includes explicit and section rooms", async () => {
    const studentRooms = await roomsForUser(student.id);
    const ids = new Set(studentRooms.map((room) => room.id));
    assert.equal(ids.has(explicitRoom.id), true);
    assert.equal(ids.has(sectionRoom.id), true);
    assert.deepEqual(
      studentRooms
        .find((room) => room.id === explicitRoom.id)
        ?.assistants.map((assistant) => assistant.id),
      [assignedAssistant.id]
    );
  });

  await check("point lookup fails closed for a nonmember", async () => {
    assert.equal(await roomForUser(noRoomStudent.id, explicitRoom.id), null);
  });

  await check("room assignment overrides a denying ordinary grant", async () => {
    assert.equal(
      await userCanAccessResource(
        student.id,
        "assistant",
        assignedAssistant.id
      ),
      true
    );
  });

  await check("student room member cannot access unassigned assistant", async () => {
    assert.equal(
      await userCanAccessResource(
        student.id,
        "assistant",
        unassignedAssistant.id
      ),
      false
    );
  });

  await check("single and batch student decisions agree", async () => {
    const accessible = await filterAccessibleResourceIds(
      student.id,
      "assistant",
      [assignedAssistant.id, unassignedAssistant.id]
    );
    assert.deepEqual(accessible, new Set([String(assignedAssistant.id)]));
  });

  await check("student-only room context is explicit", async () => {
    const context = await getRoomAssistantAccessContext(student.id, [
      assignedAssistant.id,
      unassignedAssistant.id,
    ]);
    assert.equal(context.isStudentOnly, true);
    assert.equal(context.hasActiveRoomMembership, true);
    assert.deepEqual(
      context.assignedAssistantIds,
      new Set([String(assignedAssistant.id)])
    );
  });

  await check("staff room member is never restricted", async () => {
    assert.equal(
      await userCanAccessResource(
        staff.id,
        "assistant",
        unassignedAssistant.id
      ),
      true
    );
  });

  await check("administrator is never restricted", async () => {
    assert.equal(
      await userCanAccessResource(
        admin.id,
        "assistant",
        unassignedAssistant.id
      ),
      true
    );
  });

  await check("student with no rooms keeps ordinary access", async () => {
    assert.equal(
      await userCanAccessResource(
        noRoomStudent.id,
        "assistant",
        unassignedAssistant.id
      ),
      true
    );
  });
} finally {
  if (assignedAssistantId !== null) {
    await deleteAllResourceGrants("assistant", assignedAssistantId);
  }
  if (explicitRoomId !== null || sectionRoomId !== null) {
    await db`
      DELETE FROM rooms
       WHERE id IN (
         ${explicitRoomId ?? "00000000-0000-0000-0000-000000000000"},
         ${sectionRoomId ?? "00000000-0000-0000-0000-000000000000"}
       )
    `;
  }
  await db`
    DELETE FROM oneroster_enrollments WHERE sourced_id = ${enrollmentId}
  `;
  await db`
    DELETE FROM oneroster_users WHERE sourced_id = ${rosterUserId}
  `;
  await db`
    DELETE FROM oneroster_classes WHERE sourced_id = ${classId}
  `;
  if (assignedAssistantId !== null || unassignedAssistantId !== null) {
    await db`
      DELETE FROM assistant_architects
       WHERE id IN (
         ${assignedAssistantId ?? -1},
         ${unassignedAssistantId ?? -1}
       )
    `;
  }
  if (noRoomStudentId !== null) {
    await db`DELETE FROM users WHERE id = ${noRoomStudentId}`;
  }
  await db.end();
}

log.info("Room assistant access smoke completed", { passed });
process.exit(0);
