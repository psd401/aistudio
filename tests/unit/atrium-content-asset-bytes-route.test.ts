/** @jest-environment node */

const mockAuthenticateRequest = jest.fn();
const mockRequireScope = jest.fn();
const mockGetOptionalRequester = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockReadBytes = jest.fn();

jest.mock("next/server", () => {
  class MockHeaders {
    private readonly values = new Map<string, string>();

    constructor(initial: Record<string, string> = {}) {
      for (const [key, value] of Object.entries(initial)) {
        this.values.set(key.toLowerCase(), value);
      }
    }

    get(name: string): string | null {
      return this.values.get(name.toLowerCase()) ?? null;
    }

    set(name: string, value: string): void {
      this.values.set(name.toLowerCase(), value);
    }
  }

  class MockNextResponse {
    readonly status: number;
    readonly headers: MockHeaders;
    private readonly body: string;

    constructor(
      body: string | Uint8Array | null,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.body =
        body instanceof Uint8Array
          ? Buffer.from(body).toString("binary")
          : (body ?? "");
      this.status = init.status ?? 200;
      this.headers = new MockHeaders(init.headers);
    }

    async json(): Promise<unknown> {
      return JSON.parse(this.body);
    }

    static json(
      data: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ): MockNextResponse {
      return new MockNextResponse(JSON.stringify(data), init);
    }
  }

  return { NextResponse: MockNextResponse };
});

jest.mock("@/lib/api", () => {
  const { NextResponse } = jest.requireMock("next/server") as typeof import("next/server");
  return {
    authenticateRequest: (...args: unknown[]) =>
      mockAuthenticateRequest(...args),
    requireScope: (...args: unknown[]) => mockRequireScope(...args),
    createErrorResponse: (
      requestId: string,
      status: number,
      code: string,
      message: string
    ) =>
      NextResponse.json(
        { error: { code, message }, requestId },
        { status }
      ),
  };
});
jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: (...args: unknown[]) =>
    mockGetOptionalRequester(...args),
}));
jest.mock("@/lib/content", () => ({
  contentAssetService: {
    readBytes: (...args: unknown[]) => mockReadBytes(...args),
  },
  requesterFromApiAuth: (...args: unknown[]) =>
    mockRequesterFromApiAuth(...args),
}));
jest.mock("@/lib/content/rest", () => ({
  contentErrorToResponse: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  generateRequestId: () => "asset-request",
}));

import type { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/content/assets/[assetId]/bytes/route";

const context = {
  params: Promise.resolve({
    assetId: "11111111-2222-4333-8444-555555555555",
  }),
};
const authorizedRequester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const guestRequester = {
  kind: "guest",
  userId: null,
  roles: [],
  isAdmin: false,
};

function requestWithHeaders(
  initial: Record<string, string> = {}
): NextRequest {
  const headers = new Map(
    Object.entries(initial).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue({
    userId: 7,
    scopes: ["content:read"],
  });
  mockRequireScope.mockReturnValue(null);
  mockRequesterFromApiAuth.mockResolvedValue(authorizedRequester);
  mockGetOptionalRequester.mockResolvedValue(guestRequester);
  mockReadBytes.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
    etag: '"normalized-digest"',
  });
});

describe("GET /api/v1/content/assets/:assetId/bytes", () => {
  it("masks a bearer scope denial as 404 without loading the asset", async () => {
    mockRequireScope.mockReturnValue({ status: 403 });
    const request = requestWithHeaders({ authorization: "Bearer token" });

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(mockRequesterFromApiAuth).not.toHaveBeenCalled();
    expect(mockReadBytes).not.toHaveBeenCalled();
  });

  it("uses the anonymous requester and returns a bodyless 304 on ETag match", async () => {
    const request = requestWithHeaders({
      "if-none-match": '"normalized-digest"',
    });

    const response = await GET(request, context);

    expect(response.status).toBe(304);
    expect(mockGetOptionalRequester).toHaveBeenCalledWith("asset-request");
    expect(mockReadBytes).toHaveBeenCalledWith(
      guestRequester,
      "11111111-2222-4333-8444-555555555555"
    );
    expect(response.headers.get("etag")).toBe('"normalized-digest"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves normalized bytes with nosniff headers to an authorized bearer", async () => {
    const request = requestWithHeaders({ authorization: "Bearer token" });

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(mockRequesterFromApiAuth).toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
