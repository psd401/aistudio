/** @jest-environment node */

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

const updateCollectionMock = jest.fn();
jest.mock("@/lib/content", () => {
  class MockContentError extends Error {}
  class MockValidationError extends MockContentError {}

  return {
    collectionManagementService: {
      create: jest.fn(),
      listManageable: jest.fn(),
      listOwnedPrivate: jest.fn(),
      update: (...args: unknown[]) => updateCollectionMock(...args),
    },
    ContentError: MockContentError,
    ValidationError: MockValidationError,
  };
});

import { updateCollectionAction } from "@/actions/db/atrium/collection-management";

beforeEach(() => {
  jest.clearAllMocks();
  hasCapabilityAccessMock.mockResolvedValue(true);
});

describe("updateCollectionAction security gate ordering", () => {
  it("authenticates before branching on a caller-controlled collection id", async () => {
    getUserRequesterMock.mockRejectedValueOnce(new Error("authNoSession"));

    const result = await updateCollectionAction("", {});

    expect(result.isSuccess).toBe(false);
    expect(getUserRequesterMock).toHaveBeenCalledTimes(1);
    expect(hasCapabilityAccessMock).not.toHaveBeenCalled();
    expect(updateCollectionMock).not.toHaveBeenCalled();
  });

  it("checks the Atrium capability before validating the collection id", async () => {
    hasCapabilityAccessMock.mockResolvedValueOnce(false);

    const result = await updateCollectionAction("", {});

    expect(result.isSuccess).toBe(false);
    expect(getUserRequesterMock).toHaveBeenCalledTimes(1);
    expect(hasCapabilityAccessMock).toHaveBeenCalledWith(
      "atrium-content",
      "cognito-sub"
    );
    expect(updateCollectionMock).not.toHaveBeenCalled();
  });
});
