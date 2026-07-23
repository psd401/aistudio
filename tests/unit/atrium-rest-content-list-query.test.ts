/**
 * GET /api/v1/content — `query` filter pass-through (Epic #1059 completion).
 *
 * The REST list endpoint exposes the same bounded title-search `query` the MCP
 * `list_content` tool does. These tests drive the real route handler (withApiAuth
 * unwrapped to the identity) and assert:
 *   - a valid `query` reaches `contentService.list` verbatim,
 *   - an over-long (>200 chars) `query` is a 400 VALIDATION_ERROR at the zod
 *     boundary — the service is never called.
 */

// --- mocks (hoisted above imports by jest) ---

const mockList = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockCreateErrorResponse = jest.fn();
const mockResolveCollectionId = jest.fn();

jest.mock("@/lib/api", () => ({
  // Unwrap: the route's exported GET becomes the raw (request, auth, requestId)
  // handler so the test can drive it without the auth middleware.
  withApiAuth: (handler: unknown) => handler,
  requireScope: jest.fn(() => null),
  createApiResponse: (...a: unknown[]) => mockCreateApiResponse(...a),
  createErrorResponse: (...a: unknown[]) => mockCreateErrorResponse(...a),
  parseRequestBody: jest.fn(),
}));

jest.mock("@/lib/content", () => {
  class MockApprovalRequiredError extends Error {}
  return {
    ApprovalRequiredError: MockApprovalRequiredError,
    contentService: { list: (...a: unknown[]) => mockList(...a) },
    hasPublishPublicScope: jest.fn(() => false),
    recordContentAudit: jest.fn(),
    requesterFromApiAuth: (...a: unknown[]) => mockRequesterFromApiAuth(...a),
  };
});

jest.mock("@/lib/content/rest", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { z } = require("zod") as typeof import("zod");
  return {
    contentErrorToResponse: jest.fn(() => ({ __marker: "content-error" })),
    resolveRestRequester: jest.fn(),
    respondApprovalRequired: jest.fn(),
    restVisibilitySchema: z.object({
      level: z.enum(["private", "group", "internal", "public"]),
    }),
  };
});

jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: jest.fn(),
  contentDeepLink: (slug: string) => `/c/${slug}`,
  resolveCollectionId: (...a: unknown[]) => mockResolveCollectionId(...a),
}));

import type { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/content/route";

type RawHandler = (
  request: NextRequest,
  auth: { scopes: string[]; cognitoSub: string },
  requestId: string
) => Promise<unknown>;

// withApiAuth is mocked to the identity, so GET IS the raw handler.
const handler = GET as unknown as RawHandler;

const REQ = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const AUTH = { scopes: ["content:read"], cognitoSub: "sub-7" };

function request(qs: string): NextRequest {
  return { url: `https://app.test/api/v1/content${qs}` } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequesterFromApiAuth.mockResolvedValue(REQ);
  mockResolveCollectionId.mockResolvedValue(undefined);
  mockList.mockResolvedValue([]);
  mockCreateApiResponse.mockReturnValue({ __marker: "ok" });
  mockCreateErrorResponse.mockReturnValue({ __marker: "error" });
});

describe("GET /api/v1/content — query filter", () => {
  it("passes a bounded query through to contentService.list", async () => {
    const result = await handler(request("?query=acceptable%20use"), AUTH, "req-1");

    expect(mockList).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({ query: "acceptable use" })
    );
    expect(result).toEqual({ __marker: "ok" });
  });

  it("combines query with the existing filters", async () => {
    await handler(
      request("?kind=document&status=published&query=policy"),
      AUTH,
      "req-2"
    );

    expect(mockList).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({
        kind: "document",
        status: "published",
        query: "policy",
      })
    );
  });

  it("rejects a query over 200 chars with a 400 VALIDATION_ERROR — service never called", async () => {
    const result = await handler(
      request(`?query=${"x".repeat(201)}`),
      AUTH,
      "req-3"
    );

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-3",
      400,
      "VALIDATION_ERROR",
      "Invalid query parameters",
      expect.anything()
    );
    expect(mockList).not.toHaveBeenCalled();
    expect(result).toEqual({ __marker: "error" });
  });
});
