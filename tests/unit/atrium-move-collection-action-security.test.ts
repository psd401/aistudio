/** @jest-environment node */

/**
 * `moveCollectionAction` gate ordering: authenticate, then capability, then
 * validate caller-controlled input, then the service — so neither validation
 * text nor the service's masked errors can act as an authorization oracle.
 */

const getUserRequesterMock = jest.fn(async () => ({
  kind: "user" as const,
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
}));
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...args: unknown[]) =>
    getUserRequesterMock(...(args as [])),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub" })),
}));

const hasCapabilityAccessMock = jest.fn(async () => true);
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) =>
    hasCapabilityAccessMock(...(args as [])),
}));

const moveMock = jest.fn();
jest.mock("@/lib/content", () => {
  class MockContentError extends Error {}
  class MockValidationError extends MockContentError {}
  return {
    collectionManagementService: {
      create: jest.fn(),
      listManageable: jest.fn(),
      listOwnedPrivate: jest.fn(),
      update: jest.fn(),
      move: (...args: unknown[]) => moveMock(...args),
    },
    ContentError: MockContentError,
    ValidationError: MockValidationError,
  };
});

import { moveCollectionAction } from "@/actions/db/atrium/collection-management";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  jest.clearAllMocks();
  hasCapabilityAccessMock.mockResolvedValue(true);
  moveMock.mockResolvedValue(undefined);
});

describe("moveCollectionAction security gate ordering", () => {
  it("authenticates before looking at the caller-controlled input", async () => {
    getUserRequesterMock.mockRejectedValueOnce(new Error("authNoSession"));

    const result = await moveCollectionAction("", -1);

    expect(result.isSuccess).toBe(false);
    expect(hasCapabilityAccessMock).not.toHaveBeenCalled();
    expect(moveMock).not.toHaveBeenCalled();
  });

  it("refuses a caller without the Atrium capability before validating", async () => {
    hasCapabilityAccessMock.mockResolvedValueOnce(false);

    const result = await moveCollectionAction(ID, 1);

    expect(result.isSuccess).toBe(false);
    expect(moveMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer or negative toIndex without calling the service", async () => {
    expect((await moveCollectionAction(ID, -1)).isSuccess).toBe(false);
    expect((await moveCollectionAction(ID, 1.5)).isSuccess).toBe(false);
    expect((await moveCollectionAction("", 0)).isSuccess).toBe(false);
    expect(moveMock).not.toHaveBeenCalled();
  });

  it("hands a valid move to the service with the UI surface", async () => {
    const result = await moveCollectionAction(ID, 2);

    expect(result.isSuccess).toBe(true);
    expect(moveMock).toHaveBeenCalledTimes(1);
    expect(moveMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7 }),
      ID,
      2,
      expect.objectContaining({ surface: "ui", requestId: expect.any(String) })
    );
  });

  it("surfaces the service's own message for a content error", async () => {
    const { ContentError } = jest.requireMock("@/lib/content") as {
      ContentError: new (message: string) => Error;
    };
    moveMock.mockRejectedValueOnce(new ContentError("Collection not found"));

    const result = await moveCollectionAction(ID, 0);

    expect(result.isSuccess).toBe(false);
    expect(result.message).toBe("Collection not found");
  });
});
