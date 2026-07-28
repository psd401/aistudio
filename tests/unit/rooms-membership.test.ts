import { readFileSync } from "node:fs";
import path from "node:path";

const mockExecuteQuery = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: <T>(rows: T[]): T[] => rows,
}));

import {
  getRoomAssistantAccessContext,
  mergeRoomMembershipEmails,
  resolveRoomMembershipEmails,
  roomsForUser,
} from "@/lib/rooms/membership";
import type { DbTransaction } from "@/lib/db/drizzle-client";

describe("room membership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("unions section and explicit membership with lowercase deduplication", () => {
    expect(
      mergeRoomMembershipEmails(
        ["Student@Example.com", "shared@example.com", null],
        ["SHARED@example.com", "explicit@example.com", " "]
      )
    ).toEqual([
      "explicit@example.com",
      "shared@example.com",
      "student@example.com",
    ]);
  });

  it("resolves the dynamic section and explicit rows through one union", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([
        { email: "SECTION@EXAMPLE.COM" },
        { email: "shared@example.com" },
      ])
      .mockResolvedValueOnce([
        { email: "explicit@example.com" },
        { email: "SHARED@example.com" },
      ]);

    await expect(resolveRoomMembershipEmails("room-id")).resolves.toEqual([
      "explicit@example.com",
      "section@example.com",
      "shared@example.com",
    ]);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });

  it("pins active-student and lowercase-email point-check semantics", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../lib/rooms/membership.ts"),
      "utf8"
    );
    expect(source).toContain(
      "lower(coalesce(${onerosterEnrollments.role}, '')) = 'student'"
    );
    expect(source).toContain("eq(onerosterEnrollments.isActive, true)");
    expect(source).toContain(
      "lower(rm.member_email) = lower(${email})"
    );
    expect(source).toContain("lower(u.email) = lower(${email})");
  });

  it("groups reverse membership rows into rooms with approved assistants", async () => {
    mockExecuteQuery.mockResolvedValue([
      {
        id: "room-a",
        name: "Biology",
        assistantId: 7,
        assistantName: "Lab Helper",
        assistantDescription: "Helps with labs",
        assistantImagePath: null,
      },
      {
        id: "room-a",
        name: "Biology",
        assistantId: 8,
        assistantName: "Study Guide",
        assistantDescription: null,
        assistantImagePath: "/guide.png",
      },
      {
        id: "room-b",
        name: "Chemistry",
        assistantId: null,
        assistantName: null,
        assistantDescription: null,
        assistantImagePath: null,
      },
    ]);

    await expect(roomsForUser(42)).resolves.toEqual([
      {
        id: "room-a",
        name: "Biology",
        assistants: [
          {
            id: 7,
            name: "Lab Helper",
            description: "Helps with labs",
            imagePath: null,
          },
          {
            id: 8,
            name: "Study Guide",
            description: null,
            imagePath: "/guide.png",
          },
        ],
      },
      { id: "room-b", name: "Chemistry", assistants: [] },
    ]);
  });

  it("maps the shared student-room access context", async () => {
    mockExecuteQuery.mockResolvedValue([
      {
        isAdministrator: false,
        isStudentOnly: true,
        hasActiveRoomMembership: true,
        assignedAssistantIds: ["7", "8"],
      },
    ]);

    await expect(
      getRoomAssistantAccessContext(42, [7, 8, 9])
    ).resolves.toEqual({
      isAdministrator: false,
      isStudentOnly: true,
      hasActiveRoomMembership: true,
      assignedAssistantIds: new Set(["7", "8"]),
    });
  });

  it("reads room authorization from a caller-owned transaction", async () => {
    const execute = jest.fn().mockResolvedValue([{
      isAdministrator: false,
      isStudentOnly: false,
      hasActiveRoomMembership: false,
      assignedAssistantIds: [],
    }]);
    const transaction = { execute } as unknown as DbTransaction;

    await expect(
      getRoomAssistantAccessContext(42, [7], transaction)
    ).resolves.toMatchObject({
      isAdministrator: false,
      assignedAssistantIds: new Set(),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});
