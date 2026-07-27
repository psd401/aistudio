const mockUserCanAccess = jest.fn();
const mockFilterAccessible = jest.fn();

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  userCanAccessResource: (...args: unknown[]) => mockUserCanAccess(...args),
  filterAccessibleResourceIds: (...args: unknown[]) =>
    mockFilterAccessible(...args),
}));

jest.mock("@/lib/api/assistant-service", () => ({
  getAssistantForAccessCheck: jest.fn(),
  validateAssistantAccess: jest.fn(),
}));

jest.mock("@/lib/db/drizzle", () => ({
  checkUserRole: jest.fn(),
}));

import { checkAssistantResourceGrants } from "@/lib/api/route-helpers";

describe("shared REST/MCP assistant room gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserCanAccess.mockResolvedValue(true);
    mockFilterAccessible.mockResolvedValue(new Set(["11"]));
  });

  it("checks assistant access for owners so room restriction cannot be bypassed", async () => {
    await expect(
      checkAssistantResourceGrants({
        userId: 42,
        architectUserId: 42,
        architectId: 7,
        modelDbIds: [11],
      })
    ).resolves.toEqual({ granted: true });

    expect(mockUserCanAccess).toHaveBeenCalledWith(
      42,
      "assistant",
      7,
      { ownerUserId: 42 }
    );
  });

  it("returns an assistant denial before checking model grants", async () => {
    mockUserCanAccess.mockResolvedValue(false);

    await expect(
      checkAssistantResourceGrants({
        userId: 42,
        architectUserId: 9,
        architectId: 7,
        modelDbIds: [11],
      })
    ).resolves.toEqual({ granted: false, reason: "assistant" });
    expect(mockFilterAccessible).not.toHaveBeenCalled();
  });
});
