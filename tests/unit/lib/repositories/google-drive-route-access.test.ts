/** @jest-environment node */

jest.mock("server-only", () => ({}));

const getServerSession = jest.fn();
const assertNotSystemManagedRepository = jest.fn();
const canModifyRepository = jest.fn();
const getUserIdFromSession = jest.fn();
const hasCapabilityAccess = jest.fn();

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertNotSystemManagedRepository: (...args: unknown[]) =>
    assertNotSystemManagedRepository(...args),
}));
jest.mock("@/actions/repositories/repository-permissions", () => ({
  canModifyRepository: (...args: unknown[]) => canModifyRepository(...args),
  getUserIdFromSession: (...args: unknown[]) =>
    getUserIdFromSession(...args),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) => hasCapabilityAccess(...args),
}));

import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";

describe("Google Drive connector route access", () => {
  beforeAll(() => {
    Object.assign(Response, {
      json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), {
          ...init,
          headers: { "Content-Type": "application/json", ...init?.headers },
        }),
    });
  });

  beforeEach(() => {
    getServerSession.mockReset().mockResolvedValue({ sub: "manager-sub" });
    assertNotSystemManagedRepository.mockReset().mockResolvedValue(undefined);
    canModifyRepository.mockReset().mockResolvedValue(true);
    getUserIdFromSession.mockReset().mockResolvedValue(42);
    hasCapabilityAccess.mockReset().mockResolvedValue(true);
  });

  test("requires both the UI capability and repository management access", async () => {
    await expect(requireRepositoryConnectorManager(7)).resolves.toEqual({
      userId: 42,
      cognitoSub: "manager-sub",
    });
    expect(hasCapabilityAccess).toHaveBeenCalledWith("knowledge-repositories");
    expect(assertNotSystemManagedRepository).toHaveBeenCalledWith(7);
    expect(canModifyRepository).toHaveBeenCalledWith(7, 42);

    canModifyRepository.mockResolvedValue(false);
    await expect(requireRepositoryConnectorManager(7)).rejects.toThrow(
      "Forbidden",
    );
  });

  test("maps deployment configuration failures to a sanitized 503", async () => {
    const response = repositoryConnectorErrorResponse(
      new Error("Google Drive is not configured for this environment"),
    );

    expect(response.status).toBe(503);
    const responseBody = await Promise.resolve(response.json());
    const parsedBody =
      typeof responseBody === "string"
        ? (JSON.parse(responseBody) as unknown)
        : responseBody;
    expect(parsedBody).toEqual({
      error: "Google Drive is not configured for this environment",
    });
  });
});
