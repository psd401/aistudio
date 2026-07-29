/** @jest-environment node */

jest.mock("server-only", () => ({}));

const mockGetRepositoryById = jest.fn();
const mockAssertNotSystemManagedRepository = jest.fn();
const mockHasRole = jest.fn();

jest.mock("@/lib/db/drizzle", () => ({
  getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
  getUserIdByCognitoSubAsNumber: jest.fn(),
}));

jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertNotSystemManagedRepository: (...args: unknown[]) =>
    mockAssertNotSystemManagedRepository(...args),
}));

jest.mock("@/utils/roles", () => ({
  hasRole: (...args: unknown[]) => mockHasRole(...args),
}));

import { canModifyUserManagedDurableRepository } from "@/actions/repositories/repository-permissions";
import { ErrorCode } from "@/types/error-types";

describe("canModifyUserManagedDurableRepository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined);
    mockGetRepositoryById.mockResolvedValue({ ownerId: 42 });
    mockHasRole.mockResolvedValue(false);
  });

  it("allows an owner after enforcing the durable repository boundary", async () => {
    await expect(
      canModifyUserManagedDurableRepository(7, 42),
    ).resolves.toBe(true);

    expect(mockAssertNotSystemManagedRepository).toHaveBeenCalledWith(7);
    expect(mockGetRepositoryById).toHaveBeenCalledWith(7);
  });

  it("masks only the guard's deliberate not-found result", async () => {
    mockAssertNotSystemManagedRepository.mockRejectedValue(
      Object.assign(new Error("repository hidden"), {
        code: ErrorCode.DB_RECORD_NOT_FOUND,
      }),
    );

    await expect(
      canModifyUserManagedDurableRepository(7, 42),
    ).resolves.toBe(false);
    expect(mockGetRepositoryById).not.toHaveBeenCalled();
  });

  it("propagates unexpected repository lookup failures", async () => {
    const failure = new Error("database unavailable");
    mockAssertNotSystemManagedRepository.mockRejectedValue(failure);

    await expect(
      canModifyUserManagedDurableRepository(7, 42),
    ).rejects.toBe(failure);
  });

  it("propagates failures while checking ownership or administrator access", async () => {
    const failure = new Error("role lookup unavailable");
    mockGetRepositoryById.mockResolvedValue({ ownerId: 9 });
    mockHasRole.mockRejectedValue(failure);

    await expect(
      canModifyUserManagedDurableRepository(7, 42),
    ).rejects.toBe(failure);
  });
});
