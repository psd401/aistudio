const mockRequireScope = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockCreateErrorResponse = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockDiscover = jest.fn();
const mockHasScope = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
  createApiResponse: (...args: unknown[]) => mockCreateApiResponse(...args),
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
}));
jest.mock("@/lib/api-keys/key-service", () => ({
  hasScope: (...args: unknown[]) => mockHasScope(...args),
}));
jest.mock("@/lib/content", () => ({
  collectionService: {
    discover: (...args: unknown[]) => mockDiscover(...args),
  },
  requesterFromApiAuth: (...args: unknown[]) =>
    mockRequesterFromApiAuth(...args),
}));
jest.mock("@/lib/content/rest", () => ({
  contentErrorToResponse: jest.fn(),
}));

import type { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/content/collections/route";

const handler = GET as unknown as (
  request: NextRequest,
  auth: { scopes: string[] },
  requestId: string
) => Promise<unknown>;
const requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireScope.mockReturnValue(null);
  mockRequesterFromApiAuth.mockResolvedValue(requester);
  mockDiscover.mockResolvedValue([
    {
      id: "collection-1",
      name: "Technology",
      slug: "technology",
      parentId: null,
      path: ["Technology"],
      defaultVisibilityLevel: "internal",
      visibleObjectCount: 2,
      children: [],
    },
  ]);
  mockCreateApiResponse.mockReturnValue({ marker: "ok" });
});

describe("GET /api/v1/content/collections (#1286)", () => {
  it("returns the service's permission-filtered tree without a second lookup", async () => {
    mockHasScope.mockReturnValue(true);
    await handler(
      {
        url: "https://app.test/api/v1/content/collections?shape=tree",
      } as NextRequest,
      { scopes: ["content:read", "content:create"] },
      "req-1"
    );

    expect(mockDiscover).toHaveBeenCalledWith(requester, {
      shape: "tree",
      includeCreateSelection: true,
    });
    expect(mockCreateApiResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "collection-1" }),
        ]),
        meta: expect.objectContaining({ shape: "tree" }),
      }),
      "req-1"
    );
  });

  it("returns a flat picker and omits create eligibility for read-only tokens", async () => {
    mockHasScope.mockReturnValue(false);
    await handler(
      {
        url: "https://app.test/api/v1/content/collections?shape=flat",
      } as NextRequest,
      { scopes: ["content:read"] },
      "req-2"
    );
    expect(mockDiscover).toHaveBeenCalledWith(requester, {
      shape: "flat",
      includeCreateSelection: false,
    });
  });

  it("rejects invalid shapes before calling the service", async () => {
    mockCreateErrorResponse.mockReturnValue({ marker: "error" });
    await handler(
      {
        url: "https://app.test/api/v1/content/collections?shape=secret",
      } as NextRequest,
      { scopes: ["content:read"] },
      "req-3"
    );
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-3",
      400,
      "VALIDATION_ERROR",
      expect.any(String),
      expect.any(Array)
    );
  });
});
