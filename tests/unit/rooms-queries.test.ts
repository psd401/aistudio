/** @jest-environment node */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mockExecuteQuery = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: (value: unknown) => value,
}));

import { searchActiveRosterStudents } from "@/lib/rooms/queries";

const dialect = new PgDialect();
let capturedQuery: SQL | undefined;

async function captureSearchQuery(
  callback: unknown,
  label: unknown
): Promise<unknown> {
  expect(label).toBe("searchActiveRosterStudents");
  const execute = jest.fn((query: SQL) => {
    capturedQuery = query;
    return Promise.resolve([]);
  });
  return (
    callback as (db: { execute: typeof execute }) => Promise<unknown>
  )({ execute });
}

describe("room roster queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedQuery = undefined;
  });

  it("preserves literal LIKE metacharacters in student searches", async () => {
    mockExecuteQuery.mockImplementationOnce(captureSearchQuery);

    await expect(
      searchActiveRosterStudents(
        "First_Last%\\Term",
        "teacher@example.com",
        false
      )
    ).resolves.toEqual([]);

    expect(capturedQuery).toBeDefined();
    const compiled = dialect.sqlToQuery(capturedQuery!);
    expect(compiled.sql).not.toContain("ESCAPE");
    expect(compiled.params).toEqual([
      false,
      "teacher@example.com",
      "%first\\_last\\%\\\\term%",
      "%first\\_last\\%\\\\term%",
      25,
    ]);
  });
});
