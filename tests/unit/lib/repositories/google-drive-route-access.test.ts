/** @jest-environment node */

jest.mock("server-only", () => ({}));

const checkUserRole = jest.fn();

jest.mock("@/lib/db/drizzle", () => ({
  checkUserRole: (...args: unknown[]) => checkUserRole(...args),
}));
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(),
}));
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertNotSystemManagedRepository: jest.fn(),
}));
jest.mock("@/actions/repositories/repository-permissions", () => ({
  canModifyRepository: jest.fn(),
  getUserIdFromSession: jest.fn(),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(),
}));

import { requireSharedDriveConnectorAdministrator } from "@/lib/repositories/google-drive/route-access";

describe("shared Drive connector authority", () => {
  beforeEach(() => {
    checkUserRole.mockReset();
  });

  test("accepts an application administrator", async () => {
    checkUserRole.mockResolvedValue(true);

    await expect(
      requireSharedDriveConnectorAdministrator({
        userId: 42,
        cognitoSub: "admin-sub",
      }),
    ).resolves.toBeUndefined();
    expect(checkUserRole).toHaveBeenCalledWith(42, "administrator");
  });

  test("rejects a non-administrator repository owner", async () => {
    checkUserRole.mockResolvedValue(false);

    await expect(
      requireSharedDriveConnectorAdministrator({
        userId: 43,
        cognitoSub: "owner-sub",
      }),
    ).rejects.toThrow("Forbidden");
  });
});
