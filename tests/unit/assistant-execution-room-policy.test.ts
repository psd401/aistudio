import { hasAssistantExecutionFeatureAccess } from "@/lib/rooms/assistant-execution-policy";

const ROOM_ACCESS = {
  isAdministrator: false,
  isStudentOnly: true,
  hasActiveRoomMembership: true,
  assignedAssistantIds: new Set(["7"]),
};

describe("assistant execution room capability policy", () => {
  it("allows the exact room-assigned assistant without the broad capability", () => {
    expect(
      hasAssistantExecutionFeatureAccess({
        hasCapability: false,
        assistantId: 7,
        roomAccess: ROOM_ACCESS,
      })
    ).toBe(true);
  });

  it("does not treat room membership as access to an unassigned assistant", () => {
    expect(
      hasAssistantExecutionFeatureAccess({
        hasCapability: false,
        assistantId: 8,
        roomAccess: ROOM_ACCESS,
      })
    ).toBe(false);
  });

  it("preserves the existing capability path", () => {
    expect(
      hasAssistantExecutionFeatureAccess({
        hasCapability: true,
        assistantId: 8,
        roomAccess: {
          ...ROOM_ACCESS,
          hasActiveRoomMembership: false,
          assignedAssistantIds: new Set(),
        },
      })
    ).toBe(true);
  });
});
