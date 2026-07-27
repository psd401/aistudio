const mockGetServerSession = jest.fn();
const mockResolveUserId = jest.fn();
const mockHasCapabilityAccess = jest.fn();
const mockGetRoomActor = jest.fn();
const mockListTeacherSections = jest.fn();
const mockAccessibleApprovedAssistantIds = jest.fn();
const mockAccessibleActiveRosterStudentEmails = jest.fn();
const mockGetRoomAuthorizationSnapshot = jest.fn();
const mockListRoomsForManagement = jest.fn();
const mockCreateManagedRoom = jest.fn();
const mockUpdateManagedRoom = jest.fn();
const mockDeactivateManagedRoom = jest.fn();

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth/resolve-user", () => ({
  resolveUserId: (...args: unknown[]) => mockResolveUserId(...args),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) =>
    mockHasCapabilityAccess(...args),
}));
jest.mock("@/lib/rooms/queries", () => ({
  getRoomActor: (...args: unknown[]) => mockGetRoomActor(...args),
  listTeacherSections: (...args: unknown[]) =>
    mockListTeacherSections(...args),
  accessibleApprovedAssistantIds: (...args: unknown[]) =>
    mockAccessibleApprovedAssistantIds(...args),
  accessibleActiveRosterStudentEmails: (...args: unknown[]) =>
    mockAccessibleActiveRosterStudentEmails(...args),
  getRoomAuthorizationSnapshot: (...args: unknown[]) =>
    mockGetRoomAuthorizationSnapshot(...args),
  listAccessibleApprovedAssistants: jest.fn().mockResolvedValue([]),
  listRoomsForManagement: (...args: unknown[]) =>
    mockListRoomsForManagement(...args),
  searchActiveRosterStudents: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/rooms/mutations", () => ({
  createManagedRoom: (...args: unknown[]) => mockCreateManagedRoom(...args),
  updateManagedRoom: (...args: unknown[]) => mockUpdateManagedRoom(...args),
  deactivateManagedRoom: (...args: unknown[]) =>
    mockDeactivateManagedRoom(...args),
}));

import {
  createRoomAction,
  getRoomsManageDataAction,
  updateRoomAction,
} from "@/actions/db/rooms-actions";

const roomId = "b56adf63-75c2-4d92-9f6f-d6d69c90a2fb";

describe("room actions — server authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerSession.mockResolvedValue({
      sub: "teacher-sub",
      email: "teacher@example.com",
    });
    mockResolveUserId.mockResolvedValue(7);
    mockHasCapabilityAccess.mockResolvedValue(true);
    mockGetRoomActor.mockResolvedValue({
      email: "teacher@example.com",
      isAdministrator: false,
    });
    mockListTeacherSections.mockResolvedValue([
      {
        sourcedId: "owned-section",
        title: "Owned",
        classCode: null,
        schoolName: null,
        studentCount: 1,
      },
    ]);
    mockAccessibleApprovedAssistantIds.mockResolvedValue(new Set<number>());
    mockAccessibleActiveRosterStudentEmails.mockResolvedValue(
      new Set(["student@example.com"])
    );
    mockListRoomsForManagement.mockResolvedValue([]);
    mockCreateManagedRoom.mockResolvedValue(roomId);
    mockUpdateManagedRoom.mockResolvedValue(undefined);
  });

  it("rejects a section that is not the signed-in teacher's own", async () => {
    const result = await createRoomAction({
      name: "Biology",
      classSourcedIds: ["other-teacher-section"],
      memberEmails: [],
      assistantIds: [],
    });

    expect(result.isSuccess).toBe(false);
    expect(mockCreateManagedRoom).not.toHaveBeenCalled();
  });

  it("rejects an assistant the teacher cannot access", async () => {
    const result = await createRoomAction({
      name: "Biology",
      classSourcedIds: ["owned-section"],
      memberEmails: [],
      assistantIds: [42],
    });

    expect(result.isSuccess).toBe(false);
    expect(mockAccessibleApprovedAssistantIds).toHaveBeenCalledWith(7, [42]);
    expect(mockCreateManagedRoom).not.toHaveBeenCalled();
  });

  it("rejects an explicit member absent from the actor's active roster scope", async () => {
    mockAccessibleActiveRosterStudentEmails.mockResolvedValue(
      new Set<string>()
    );

    const result = await createRoomAction({
      name: "Biology",
      classSourcedIds: ["owned-section"],
      memberEmails: ["outsider@example.com"],
      assistantIds: [],
    });

    expect(result.isSuccess).toBe(false);
    expect(mockAccessibleActiveRosterStudentEmails).toHaveBeenCalledWith(
      "teacher@example.com",
      false,
      ["outsider@example.com"]
    );
    expect(mockCreateManagedRoom).not.toHaveBeenCalled();
  });

  it("allows an active roster student in the actor's scope", async () => {
    const result = await createRoomAction({
      name: "Biology",
      classSourcedIds: ["owned-section"],
      memberEmails: ["STUDENT@example.com"],
      assistantIds: [],
    });

    expect(result.isSuccess).toBe(true);
    expect(mockAccessibleActiveRosterStudentEmails).toHaveBeenCalledWith(
      "teacher@example.com",
      false,
      ["student@example.com"]
    );
    expect(mockCreateManagedRoom).toHaveBeenCalled();
  });

  it("rejects a non-creator non-administrator before assignment checks", async () => {
    mockGetRoomAuthorizationSnapshot.mockResolvedValue({
      createdBy: 99,
      classSourcedIds: [],
    });

    const result = await updateRoomAction(roomId, {
      name: "Changed",
      classSourcedIds: [],
      memberEmails: [],
      assistantIds: [],
    });

    expect(result.isSuccess).toBe(false);
    expect(mockListTeacherSections).not.toHaveBeenCalled();
    expect(mockUpdateManagedRoom).not.toHaveBeenCalled();
  });

  it("rejects an owner preserving a section they no longer teach", async () => {
    mockGetRoomAuthorizationSnapshot.mockResolvedValue({
      createdBy: 7,
      classSourcedIds: ["former-section"],
    });

    const result = await updateRoomAction(roomId, {
      name: "Changed",
      classSourcedIds: ["former-section"],
      memberEmails: [],
      assistantIds: [],
    });

    expect(result.isSuccess).toBe(false);
    expect(mockUpdateManagedRoom).not.toHaveBeenCalled();
  });

  it("allows an administrator to preserve existing section links", async () => {
    mockGetRoomActor.mockResolvedValue({
      email: "admin@example.com",
      isAdministrator: true,
    });
    mockGetRoomAuthorizationSnapshot.mockResolvedValue({
      createdBy: 99,
      classSourcedIds: ["existing-section"],
    });

    const result = await updateRoomAction(roomId, {
      name: "Maintained",
      classSourcedIds: ["existing-section"],
      memberEmails: [],
      assistantIds: [],
    });

    expect(result.isSuccess).toBe(true);
    expect(mockUpdateManagedRoom).toHaveBeenCalled();
  });

  it("rejects every entry point when the rooms-manage capability is denied", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false);

    const created = await createRoomAction({
      name: "Biology",
      classSourcedIds: ["owned-section"],
      memberEmails: [],
      assistantIds: [],
    });
    const loaded = await getRoomsManageDataAction();

    expect(created.isSuccess).toBe(false);
    expect(loaded.isSuccess).toBe(false);
    expect(mockHasCapabilityAccess).toHaveBeenCalledWith(
      "rooms-manage",
      "teacher-sub"
    );
    // The gate must short-circuit before any room data is read or written.
    expect(mockGetRoomActor).not.toHaveBeenCalled();
    expect(mockListRoomsForManagement).not.toHaveBeenCalled();
    expect(mockCreateManagedRoom).not.toHaveBeenCalled();
  });

  it("scopes the room list to the actor for a non-administrator", async () => {
    const result = await getRoomsManageDataAction();

    expect(result.isSuccess).toBe(true);
    expect(mockListRoomsForManagement).toHaveBeenCalledWith(7, false);
    expect(result.data?.isAdministrator).toBe(false);
  });

  it("loads every active room for administrators", async () => {
    mockGetRoomActor.mockResolvedValue({
      email: "admin@example.com",
      isAdministrator: true,
    });

    const result = await getRoomsManageDataAction();

    expect(result.isSuccess).toBe(true);
    expect(mockListRoomsForManagement).toHaveBeenCalledWith(7, true);
    expect(result.data?.isAdministrator).toBe(true);
  });
});
