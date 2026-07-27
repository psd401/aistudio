import {
  canManageRoom,
  findUnauthorizedAssistantIds,
  findUnauthorizedClassIds,
} from "@/lib/rooms/validation";

describe("room server-side assignment decisions", () => {
  it("rejects every section a non-admin teacher no longer owns", () => {
    const owned = new Set(["teacher-section"]);
    expect(
      findUnauthorizedClassIds(
        ["existing-admin-room-section", "teacher-section", "other-section"],
        ["existing-admin-room-section"],
        owned,
        false
      )
    ).toEqual(["existing-admin-room-section", "other-section"]);
  });

  it("allows an administrator to preserve existing section links", () => {
    expect(
      findUnauthorizedClassIds(
        ["existing-section", "new-section"],
        ["existing-section"],
        new Set(),
        true
      )
    ).toEqual(["new-section"]);
  });

  it("rejects assistants absent from the fresh accessible-approved set", () => {
    expect(
      findUnauthorizedAssistantIds([10, 11, 12], new Set([10, 12]))
    ).toEqual([11]);
  });

  it("permits only the creator or an administrator to mutate a room", () => {
    expect(canManageRoom(7, 7, false)).toBe(true);
    expect(canManageRoom(7, 8, true)).toBe(true);
    expect(canManageRoom(7, 8, false)).toBe(false);
    expect(canManageRoom(7, null, false)).toBe(false);
  });
});
