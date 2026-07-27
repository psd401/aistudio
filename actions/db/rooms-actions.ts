"use server";

/**
 * Capability-gated room management actions (Epic #1308 / Issue #1313).
 *
 * The server is authoritative for section ownership, assistant access, and
 * creator/administrator mutation rights. Roster emails and individual students
 * are never written to logs.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { resolveUserId } from "@/lib/auth/resolve-user";
import {
  createSuccess,
  ErrorFactories,
  handleError,
} from "@/lib/error-utils";
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import {
  accessibleActiveRosterStudentEmails,
  accessibleApprovedAssistantIds,
  getRoomActor,
  getRoomAuthorizationSnapshot,
  listAccessibleApprovedAssistants,
  listRoomsForManagement,
  listTeacherSections,
  searchActiveRosterStudents,
  type AccessibleAssistantOption,
  type ManagedRoom,
  type RosterStudentOption,
  type TeacherSectionOption,
} from "@/lib/rooms/queries";
import {
  createManagedRoom,
  deactivateManagedRoom,
  updateManagedRoom,
  type RoomMutationActor,
  type RoomMutationInput,
} from "@/lib/rooms/mutations";
import {
  canManageRoom,
  findUnauthorizedAssistantIds,
  findUnauthorizedClassIds,
} from "@/lib/rooms/validation";
import { normalizeEmail } from "@/lib/groups/normalize";
import { hasCapabilityAccess } from "@/utils/roles";
import type { ActionState } from "@/types";

const ROOMS_MANAGE_PATH = "/rooms/manage";
const ROOM_NAME_MAX = 120;
const MAX_ROOM_CLASSES = 50;
const MAX_EXPLICIT_MEMBERS = 200;
const MAX_ASSISTANTS = 100;
const STUDENT_SEARCH_MAX = 200;

const roomMutationSchema = z.object({
  name: z.string().trim().min(1).max(ROOM_NAME_MAX),
  classSourcedIds: z
    .array(z.string().trim().min(1).max(512))
    .max(MAX_ROOM_CLASSES),
  memberEmails: z
    .array(z.string().trim().email().max(320))
    .max(MAX_EXPLICIT_MEMBERS),
  assistantIds: z
    .array(z.number().int().positive())
    .max(MAX_ASSISTANTS),
});

const roomIdSchema = z.string().uuid();
const studentSearchSchema = z
  .string()
  .trim()
  .min(2)
  .max(STUDENT_SEARCH_MAX);

export interface RoomsManageData {
  rooms: ManagedRoom[];
  sections: TeacherSectionOption[];
  assistants: AccessibleAssistantOption[];
  isAdministrator: boolean;
}

interface RoomsActor extends RoomMutationActor {
  email: string;
}

function parseRoomInput(input: unknown): RoomMutationInput {
  const parsed = roomMutationSchema.safeParse(input);
  if (!parsed.success) {
    throw ErrorFactories.validationFailed(
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "room",
        message: issue.message,
      }))
    );
  }
  return {
    name: parsed.data.name,
    classSourcedIds: [
      ...new Set(parsed.data.classSourcedIds.map((value) => value.trim())),
    ],
    memberEmails: [
      ...new Set(
        parsed.data.memberEmails.map((value) => normalizeEmail(value))
      ),
    ],
    assistantIds: [...new Set(parsed.data.assistantIds)],
  };
}

function parseRoomId(roomId: string): string {
  const parsed = roomIdSchema.safeParse(roomId);
  if (!parsed.success) {
    throw ErrorFactories.authzResourceNotFound("room", "invalid");
  }
  return parsed.data;
}

async function requireRoomsActor(
  requestId: string,
  log: ReturnType<typeof createLogger>
): Promise<RoomsActor> {
  const session = await getServerSession();
  if (!session) {
    log.warn("Unauthenticated room-management request");
    throw ErrorFactories.authNoSession();
  }

  const userId = await resolveUserId(session, requestId);
  if (!(await hasCapabilityAccess("rooms-manage", session.sub))) {
    log.warn("Room-management capability denied", { userId });
    throw ErrorFactories.authzInsufficientPermissions("rooms-manage");
  }

  const actor = await getRoomActor(userId);
  if (!actor) {
    throw ErrorFactories.authzResourceNotFound("user", String(userId));
  }
  return {
    userId,
    email: actor.email,
    isAdministrator: actor.isAdministrator,
  };
}

async function validateAssignments(
  actor: RoomsActor,
  input: RoomMutationInput,
  existingClassIds: string[]
): Promise<void> {
  const sections = await listTeacherSections(actor.email);
  const teacherClassIds = new Set(
    sections.map((section) => section.sourcedId)
  );
  const unauthorizedClasses = findUnauthorizedClassIds(
    input.classSourcedIds,
    existingClassIds,
    teacherClassIds,
    actor.isAdministrator
  );
  if (unauthorizedClasses.length > 0) {
    // Preserve visibility-before-permission: do not reveal whether the supplied
    // sourced ID belongs to another teacher.
    throw ErrorFactories.authzResourceNotFound(
      "OneRoster class",
      unauthorizedClasses[0]
    );
  }

  const accessibleIds = await accessibleApprovedAssistantIds(
    actor.userId,
    input.assistantIds
  );
  const unauthorizedAssistants = findUnauthorizedAssistantIds(
    input.assistantIds,
    accessibleIds
  );
  if (unauthorizedAssistants.length > 0) {
    throw ErrorFactories.authzResourceNotFound(
      "assistant",
      String(unauthorizedAssistants[0])
    );
  }

  const accessibleMemberEmails =
    await accessibleActiveRosterStudentEmails(
      actor.email,
      actor.isAdministrator,
      input.memberEmails
    );
  const unauthorizedMemberEmail = input.memberEmails.find(
    (email) => !accessibleMemberEmails.has(email)
  );
  if (unauthorizedMemberEmail) {
    throw ErrorFactories.authzResourceNotFound(
      "OneRoster student",
      unauthorizedMemberEmail
    );
  }
}

export async function getRoomsManageDataAction(): Promise<
  ActionState<RoomsManageData>
> {
  const requestId = generateRequestId();
  const timer = startTimer("getRoomsManageDataAction");
  const log = createLogger({ requestId, action: "getRoomsManageDataAction" });
  try {
    const actor = await requireRoomsActor(requestId, log);
    const [rooms, sections, assistants] = await Promise.all([
      listRoomsForManagement(actor.userId, actor.isAdministrator),
      listTeacherSections(actor.email),
      listAccessibleApprovedAssistants(actor.userId),
    ]);
    timer({ status: "success" });
    return createSuccess(
      { rooms, sections, assistants, isAdministrator: actor.isAdministrator },
      "Room management data loaded"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load room management.", {
      context: "getRoomsManageDataAction",
      requestId,
      operation: "getRoomsManageDataAction",
    });
  }
}

export async function searchRoomStudentsAction(
  search: unknown
): Promise<ActionState<RosterStudentOption[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("searchRoomStudentsAction");
  const log = createLogger({ requestId, action: "searchRoomStudentsAction" });
  try {
    const actor = await requireRoomsActor(requestId, log);
    const parsed = studentSearchSchema.safeParse(search);
    if (!parsed.success) {
      throw ErrorFactories.validationFailed([
        { field: "search", message: "Enter between 2 and 200 characters." },
      ]);
    }
    const students = await searchActiveRosterStudents(
      parsed.data,
      actor.email,
      actor.isAdministrator
    );
    timer({ status: "success", count: students.length });
    return createSuccess(students, "Student search complete");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to search roster students.", {
      context: "searchRoomStudentsAction",
      requestId,
      operation: "searchRoomStudentsAction",
    });
  }
}

export async function createRoomAction(
  input: RoomMutationInput
): Promise<ActionState<{ roomId: string }>> {
  const requestId = generateRequestId();
  const timer = startTimer("createRoomAction");
  const log = createLogger({ requestId, action: "createRoomAction" });
  try {
    const actor = await requireRoomsActor(requestId, log);
    const parsed = parseRoomInput(input);
    await validateAssignments(actor, parsed, []);
    const roomId = await createManagedRoom(actor, parsed);
    revalidatePath(ROOMS_MANAGE_PATH);
    log.info("Room created", {
      userId: actor.userId,
      roomId,
      classCount: parsed.classSourcedIds.length,
      explicitMemberCount: parsed.memberEmails.length,
      assistantCount: parsed.assistantIds.length,
    });
    timer({ status: "success" });
    return createSuccess({ roomId }, "Room created");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to create room.", {
      context: "createRoomAction",
      requestId,
      operation: "createRoomAction",
    });
  }
}

export async function updateRoomAction(
  roomId: string,
  input: RoomMutationInput
): Promise<ActionState<{ roomId: string }>> {
  const requestId = generateRequestId();
  const timer = startTimer("updateRoomAction");
  const log = createLogger({ requestId, action: "updateRoomAction" });
  try {
    const actor = await requireRoomsActor(requestId, log);
    const id = parseRoomId(roomId);
    const snapshot = await getRoomAuthorizationSnapshot(id);
    if (
      !snapshot ||
      !canManageRoom(
        actor.userId,
        snapshot.createdBy,
        actor.isAdministrator
      )
    ) {
      throw ErrorFactories.authzResourceNotFound("room", id);
    }
    const parsed = parseRoomInput(input);
    await validateAssignments(actor, parsed, snapshot.classSourcedIds);
    await updateManagedRoom(id, actor, parsed);
    revalidatePath(ROOMS_MANAGE_PATH);
    log.info("Room updated", {
      userId: actor.userId,
      roomId: id,
      classCount: parsed.classSourcedIds.length,
      explicitMemberCount: parsed.memberEmails.length,
      assistantCount: parsed.assistantIds.length,
    });
    timer({ status: "success" });
    return createSuccess({ roomId: id }, "Room updated");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update room.", {
      context: "updateRoomAction",
      requestId,
      operation: "updateRoomAction",
    });
  }
}

export async function deleteRoomAction(
  roomId: string
): Promise<ActionState<{ roomId: string }>> {
  const requestId = generateRequestId();
  const timer = startTimer("deleteRoomAction");
  const log = createLogger({ requestId, action: "deleteRoomAction" });
  try {
    const actor = await requireRoomsActor(requestId, log);
    const id = parseRoomId(roomId);
    const snapshot = await getRoomAuthorizationSnapshot(id);
    if (
      !snapshot ||
      !canManageRoom(
        actor.userId,
        snapshot.createdBy,
        actor.isAdministrator
      )
    ) {
      throw ErrorFactories.authzResourceNotFound("room", id);
    }
    await deactivateManagedRoom(id, actor);
    revalidatePath(ROOMS_MANAGE_PATH);
    log.info("Room deactivated", { userId: actor.userId, roomId: id });
    timer({ status: "success" });
    return createSuccess({ roomId: id }, "Room deleted");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to delete room.", {
      context: "deleteRoomAction",
      requestId,
      operation: "deleteRoomAction",
    });
  }
}
