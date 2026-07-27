import { readFileSync } from "node:fs";
import path from "node:path";

const mockExecuteQuery = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: <T>(rows: T[]): T[] => rows,
}));

import {
  mergeRoomMembershipEmails,
  resolveRoomMembershipEmails,
} from "@/lib/rooms/membership";

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
});
