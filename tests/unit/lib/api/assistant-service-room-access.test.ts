const mockExecuteQuery = jest.fn();
const mockFilterAccessible = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}));

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: (...args: unknown[]) =>
    mockFilterAccessible(...args),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { listAccessibleAssistants } from "@/lib/api/assistant-service";

describe("assistant list room filtering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("server-filters REST/MCP list data through the shared assistant gate", async () => {
    const now = new Date();
    mockExecuteQuery.mockResolvedValue([
      {
        id: 1,
        name: "Assigned",
        description: null,
        status: "approved",
        userId: 9,
        createdAt: now,
        updatedAt: now,
        promptCount: 1,
        inputFieldCount: 0,
      },
      {
        id: 2,
        name: "Hidden",
        description: null,
        status: "approved",
        userId: 42,
        createdAt: now,
        updatedAt: now,
        promptCount: 1,
        inputFieldCount: 0,
      },
    ]);
    mockFilterAccessible.mockResolvedValue(new Set(["1"]));

    const result = await listAccessibleAssistants(42, false, { limit: 10 });

    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(mockFilterAccessible).toHaveBeenCalledWith(
      42,
      "assistant",
      [1, 2],
      { ownedResourceIds: [2] }
    );
  });
});
