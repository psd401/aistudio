const mockExecuteQuery = jest.fn();
const mockRoomAccess = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: <T>(rows: T[]): T[] => rows,
}));

jest.mock("@/lib/rooms/membership", () => ({
  getRoomAssistantAccessContext: (...args: unknown[]) =>
    mockRoomAccess(...args),
}));

import {
  filterAccessibleResourceIds,
  userCanAccessResource,
} from "@/lib/db/drizzle/resource-access";

const NO_ROOM = {
  isAdministrator: false,
  isStudentOnly: false,
  hasActiveRoomMembership: false,
  assignedAssistantIds: new Set<string>(),
};

describe("shared assistant room authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRoomAccess.mockResolvedValue(NO_ROOM);
  });

  it("grants a room-assigned assistant before ordinary grants", async () => {
    mockRoomAccess.mockResolvedValue({
      ...NO_ROOM,
      assignedAssistantIds: new Set(["7"]),
    });

    await expect(
      userCanAccessResource(42, "assistant", 7)
    ).resolves.toBe(true);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("restricts a student-only room member even when they own the assistant", async () => {
    mockRoomAccess.mockResolvedValue({
      ...NO_ROOM,
      isStudentOnly: true,
      hasActiveRoomMembership: true,
    });

    await expect(
      userCanAccessResource(42, "assistant", 7, { ownerUserId: 42 })
    ).resolves.toBe(false);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("never restricts administrators or staff", async () => {
    mockRoomAccess.mockResolvedValueOnce({
      ...NO_ROOM,
      isAdministrator: true,
      isStudentOnly: true,
      hasActiveRoomMembership: true,
    });
    await expect(
      userCanAccessResource(42, "assistant", 7)
    ).resolves.toBe(true);

    mockRoomAccess.mockResolvedValueOnce({
      ...NO_ROOM,
      hasActiveRoomMembership: true,
    });
    await expect(
      userCanAccessResource(42, "assistant", 8, { ownerUserId: 42 })
    ).resolves.toBe(true);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("preserves ordinary grant behavior for a student with no rooms", async () => {
    mockRoomAccess.mockResolvedValue({
      ...NO_ROOM,
      isStudentOnly: true,
    });
    mockExecuteQuery.mockResolvedValue([{ allowed: true }]);

    await expect(
      userCanAccessResource(42, "assistant", 7)
    ).resolves.toBe(true);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });

  it("batch restriction returns only room-assigned assistant ids", async () => {
    mockRoomAccess.mockResolvedValue({
      ...NO_ROOM,
      isStudentOnly: true,
      hasActiveRoomMembership: true,
      assignedAssistantIds: new Set(["2"]),
    });

    await expect(
      filterAccessibleResourceIds(42, "assistant", [1, 2, 3], {
        ownedResourceIds: [1],
      })
    ).resolves.toEqual(new Set(["2"]));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("batch access unions room assignment, ownership, and ordinary grants", async () => {
    mockRoomAccess.mockResolvedValue({
      ...NO_ROOM,
      hasActiveRoomMembership: true,
      assignedAssistantIds: new Set(["1"]),
    });
    mockExecuteQuery.mockResolvedValue([
      { resource_id: "4", matched: false },
    ]);

    await expect(
      filterAccessibleResourceIds(42, "assistant", [1, 2, 3, 4], {
        ownedResourceIds: [2],
      })
    ).resolves.toEqual(new Set(["1", "2", "3"]));
  });
});
