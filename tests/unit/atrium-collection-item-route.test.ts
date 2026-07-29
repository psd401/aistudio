/** @jest-environment node */

const requireScopeMock = jest.fn();
const parseRequestBodyMock = jest.fn();
const createApiResponseMock = jest.fn();
const createErrorResponseMock = jest.fn();
const updateMock = jest.fn();
const resolveRestRequesterMock = jest.fn();
const capabilityMock = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (...args: unknown[]) => requireScopeMock(...args),
  parseRequestBody: (...args: unknown[]) => parseRequestBodyMock(...args),
  createApiResponse: (...args: unknown[]) => createApiResponseMock(...args),
  createErrorResponse: (...args: unknown[]) => createErrorResponseMock(...args),
}));
jest.mock("@/lib/content", () => ({
  collectionManagementService: {
    update: (...args: unknown[]) => updateMock(...args),
  },
}));
jest.mock("@/lib/content/rest", () => ({
  contentErrorToResponse: jest.fn(),
  updateCollectionBodySchema: {},
  resolveRestRequester: (...args: unknown[]) =>
    resolveRestRequesterMock(...args),
}));
jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: (...args: unknown[]) =>
    capabilityMock(...args),
}));

import type { NextRequest } from "next/server";
import { PATCH } from "@/app/api/v1/content/collections/[id]/route";

const handler = PATCH as unknown as (
  request: NextRequest,
  auth: { scopes: string[] },
  requestId: string,
  params: { id?: string }
) => Promise<unknown>;

const requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  requireScopeMock.mockReturnValue(null);
  parseRequestBodyMock.mockResolvedValue({
    data: { parentId: null, position: 1 },
  });
  resolveRestRequesterMock.mockResolvedValue({ req: requester });
  capabilityMock.mockRejectedValue(
    new Error("UI capability checks must not gate REST endpoints")
  );
  updateMock.mockResolvedValue({
    id: "f9999999-9999-4999-8999-999999999999",
    name: "Moved",
  });
});

describe("PATCH /api/v1/content/collections/:id (#1438)", () => {
  it("uses the API scope without applying a UI capability gate", async () => {
    await handler(
      {} as NextRequest,
      {
        scopes: ["content:update"],
        authType: "session",
        cognitoSub: "cognito-sub",
      } as { scopes: string[] },
      "req-update",
      { id: "f9999999-9999-4999-8999-999999999999" }
    );

    expect(capabilityMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith(
      requester,
      "f9999999-9999-4999-8999-999999999999",
      { parentId: null, position: 1 },
      { surface: "rest", requestId: "req-update" }
    );
    expect(createApiResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "f9999999-9999-4999-8999-999999999999",
        }),
      }),
      "req-update"
    );
  });

  it("rejects a missing id before body parsing", async () => {
    createErrorResponseMock.mockReturnValue({ marker: "bad" });
    await handler(
      {} as NextRequest,
      { scopes: ["content:update"] },
      "req-missing",
      {}
    );
    expect(parseRequestBodyMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
