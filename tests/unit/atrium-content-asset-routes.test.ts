const mockRequireScope = jest.fn();
const mockParseRequestBody = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockCreateErrorResponse = jest.fn();
const mockResolveRestRequester = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockContentErrorToResponse = jest.fn();
const mockAssertCapability = jest.fn();
const mockInitiate = jest.fn();
const mockComplete = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockHashIdempotencyRequest = jest.fn();
const mockIdempotencyScope = jest.fn();
const mockValidateIdempotencyKey = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
  parseRequestBody: (...args: unknown[]) => mockParseRequestBody(...args),
  createApiResponse: (...args: unknown[]) => mockCreateApiResponse(...args),
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
}));
jest.mock("@/lib/content", () => ({
  contentAssetService: {
    initiate: (...args: unknown[]) => mockInitiate(...args),
    complete: (...args: unknown[]) => mockComplete(...args),
    list: (...args: unknown[]) => mockList(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
  recordContentAudit: jest.fn(),
  hashIdempotencyRequest: (...args: unknown[]) =>
    mockHashIdempotencyRequest(...args),
  idempotencyScope: (...args: unknown[]) => mockIdempotencyScope(...args),
  validateIdempotencyKey: (...args: unknown[]) =>
    mockValidateIdempotencyKey(...args),
  requesterFromApiAuth: (...args: unknown[]) =>
    mockRequesterFromApiAuth(...args),
}));
jest.mock("@/lib/content/rest", () => ({
  resolveRestRequester: (...args: unknown[]) =>
    mockResolveRestRequester(...args),
  contentErrorToResponse: (...args: unknown[]) =>
    mockContentErrorToResponse(...args),
}));
jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: (...args: unknown[]) =>
    mockAssertCapability(...args),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn() }),
}));

import type { NextRequest } from "next/server";
import {
  GET as LIST,
  POST as INITIATE,
} from "@/app/api/v1/content/[id]/assets/route";
import { GET as GET_ITEM } from "@/app/api/v1/content/[id]/assets/[assetId]/route";
import { POST as COMPLETE } from "@/app/api/v1/content/[id]/assets/[assetId]/complete/route";

const auth = {
  scopes: ["content:read", "content:update"],
  userId: 7,
  cognitoSub: "sub-7",
};
const requester = {
  kind: "user" as const,
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const request = {
  headers: { get: () => null },
} as unknown as NextRequest;
const objectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const assetId = "11111111-2222-4333-8444-555555555555";

type Handler = (
  request: NextRequest,
  authContext: typeof auth,
  requestId: string,
  params: { id: string; assetId?: string }
) => Promise<unknown>;
const listHandler = LIST as unknown as Handler;
const initiateHandler = INITIATE as unknown as Handler;
const getHandler = GET_ITEM as unknown as Handler;
const completeHandler = COMPLETE as unknown as Handler;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireScope.mockReturnValue(null);
  mockResolveRestRequester.mockResolvedValue({ req: requester });
  mockRequesterFromApiAuth.mockResolvedValue(requester);
  mockCreateApiResponse.mockReturnValue({ status: 200 });
  mockCreateErrorResponse.mockReturnValue({ status: 400 });
  mockContentErrorToResponse.mockReturnValue({ status: 404 });
  mockHashIdempotencyRequest.mockReturnValue("a".repeat(64));
  mockIdempotencyScope.mockReturnValue({ keyHash: "scope-key" });
  mockValidateIdempotencyKey.mockReturnValue(true);
});

function defineAtriumAuthoredAssetRoutes1284Suite1Part1() {
  it("lists metadata only after read scope and object visibility resolution", async () => {
    mockList.mockResolvedValue([{ id: assetId }]);
    await listHandler(request, auth, "req-list", { id: objectId });
    expect(mockRequireScope).toHaveBeenCalledWith(
      auth,
      "content:read",
      "req-list"
    );
    expect(mockList).toHaveBeenCalledWith(requester, objectId);
    expect(mockCreateApiResponse).toHaveBeenCalledWith(
      {
        data: [{ id: assetId }],
        meta: { requestId: "req-list", count: 1 },
      },
      "req-list"
    );
  });

  it("requires update scope, Atrium capability, and the service edit gate to initiate", async () => {
    const input = {
      filename: "step.png",
      contentType: "image/png",
      byteLength: 100,
      sha256: "A".repeat(43),
      purpose: "capture_step",
    };
    mockParseRequestBody.mockResolvedValue({ data: input });
    mockInitiate.mockResolvedValue({
      asset: { id: assetId },
      replayed: false,
    });
    await initiateHandler(request, auth, "req-init", { id: objectId });

    expect(mockRequireScope).toHaveBeenCalledWith(
      auth,
      "content:update",
      "req-init"
    );
    expect(mockAssertCapability).toHaveBeenCalledWith(auth);
    expect(mockInitiate).toHaveBeenCalledWith(
      requester,
      objectId,
      input,
      undefined
    );
  });

  it("scopes a client idempotency key and marks a recovered reservation", async () => {
    const keyedRequest = {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "idempotency-key"
            ? "capture-upload-42"
            : null,
      },
    } as unknown as NextRequest;
    const setResponseHeader = jest.fn();
    mockCreateApiResponse.mockReturnValue({
      status: 201,
      headers: { set: setResponseHeader },
    });
    const input = {
      filename: "step.png",
      contentType: "image/png",
      byteLength: 100,
      sha256: "A".repeat(43),
      purpose: "capture_step",
    };
    mockParseRequestBody.mockResolvedValue({ data: input });
    mockInitiate.mockResolvedValue({
      asset: { id: assetId },
      replayed: true,
    });

    await initiateHandler(keyedRequest, auth, "req-retry", { id: objectId });

    expect(mockValidateIdempotencyKey).toHaveBeenCalledWith(
      "capture-upload-42"
    );
    expect(mockIdempotencyScope).toHaveBeenCalledWith(
      auth,
      keyedRequest,
      `/api/v1/content/${objectId}/assets`,
      "capture-upload-42"
    );
    expect(mockInitiate).toHaveBeenCalledWith(
      requester,
      objectId,
      input,
      {
        keyHash: "a".repeat(64),
        requestHash: "a".repeat(64),
      }
    );
    expect(setResponseHeader).toHaveBeenCalledWith(
      "Idempotency-Replayed",
      "true"
    );
  });

  }

function defineAtriumAuthoredAssetRoutes1284Suite1Part2() {it("rejects an invalid asset initiation idempotency key", async () => {
    const invalidRequest = {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "idempotency-key" ? "contains space" : null,
      },
    } as unknown as NextRequest;
    mockParseRequestBody.mockResolvedValue({
      data: {
        filename: "step.png",
        contentType: "image/png",
        byteLength: 100,
        sha256: "A".repeat(43),
        purpose: "capture_step",
      },
    });
    mockValidateIdempotencyKey.mockReturnValue(false);

    await initiateHandler(invalidRequest, auth, "req-invalid-key", {
      id: objectId,
    });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-invalid-key",
      400,
      "INVALID_IDEMPOTENCY_KEY",
      expect.any(String)
    );
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it("completes through the same authoring gates and passes the immutable id", async () => {
    const input = { sha256: "A".repeat(43), etag: '"upload-etag"' };
    mockParseRequestBody.mockResolvedValue({ data: input });
    mockComplete.mockResolvedValue({ id: assetId, state: "ready" });
    await completeHandler(request, auth, "req-complete", {
      id: objectId,
      assetId,
    });

    expect(mockAssertCapability).toHaveBeenCalledWith(auth);
    expect(mockComplete).toHaveBeenCalledWith(
      requester,
      objectId,
      assetId,
      input
    );
  });

  it("maps denied item reads through the content existence-masking response", async () => {
    const denied = new Error("masked");
    mockGet.mockRejectedValue(denied);
    const response = await getHandler(request, auth, "req-denied", {
      id: objectId,
      assetId,
    });
    expect(mockContentErrorToResponse).toHaveBeenCalledWith(
      denied,
      "req-denied"
    );
    expect(response).toEqual({ status: 404 });
  });

  it("short-circuits before service access when a scope is missing", async () => {
    const forbidden = { status: 403 };
    mockRequireScope.mockReturnValue(forbidden);
    const response = await listHandler(request, auth, "req-scope", {
      id: objectId,
    });
    expect(response).toBe(forbidden);
    expect(mockList).not.toHaveBeenCalled();
  });
}

const defineAtriumAuthoredAssetRoutes1284Suite1 = () => {
  defineAtriumAuthoredAssetRoutes1284Suite1Part1()
  defineAtriumAuthoredAssetRoutes1284Suite1Part2()
};

describe("Atrium authored asset routes (#1284)", defineAtriumAuthoredAssetRoutes1284Suite1);
