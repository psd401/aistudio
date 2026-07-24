const mockRequireScope = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockCreateErrorResponse = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockResolve = jest.fn();
const mockLoadResolved = jest.fn();
const mockContentErrorToResponse = jest.fn();

class FakeHeaders {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.set(key, value);
    }
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }

  set(name: string, value: string): void {
    this.values.set(name.toLowerCase(), value);
  }
}

function fakeResponse(status = 200, body = "") {
  return {
    status,
    headers: new FakeHeaders(),
    text: async () => body,
  };
}

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
  createApiResponse: (...args: unknown[]) => mockCreateApiResponse(...args),
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
}));
jest.mock("@/lib/content", () => ({
  requesterFromApiAuth: (...args: unknown[]) =>
    mockRequesterFromApiAuth(...args),
  contentSourceService: {
    resolve: (...args: unknown[]) => mockResolve(...args),
    loadResolved: (...args: unknown[]) => mockLoadResolved(...args),
  },
  contentSourceEtag: (id: string) => `"${id}"`,
  ifNoneMatchIncludes: (header: string | null, etag: string) =>
    header === etag,
}));
jest.mock("@/lib/content/rest", () => ({
  contentErrorToResponse: (...args: unknown[]) =>
    mockContentErrorToResponse(...args),
}));
jest.mock("next/server", () => {
  class MockHeaders {
    private readonly values = new Map<string, string>();
    constructor(initial: Record<string, string> = {}) {
      for (const [key, value] of Object.entries(initial)) {
        this.values.set(key.toLowerCase(), value);
      }
    }
    get(name: string) {
      return this.values.get(name.toLowerCase()) ?? null;
    }
    set(name: string, value: string) {
      this.values.set(name.toLowerCase(), value);
    }
  }
  return {
    NextResponse: class {
      readonly status: number;
      readonly headers: MockHeaders;
      private readonly body: string;
      constructor(
        body: string | null,
        init: { status?: number; headers?: Record<string, string> } = {}
      ) {
        this.body = body ?? "";
        this.status = init.status ?? 200;
        this.headers = new MockHeaders(init.headers);
      }
      async text() {
        return this.body;
      }
    },
  };
});

import type { NextRequest } from "next/server";
import { GET as GET_CURRENT } from "@/app/api/v1/content/[id]/source/route";
import { GET as GET_VERSION } from "@/app/api/v1/content/[id]/versions/[versionId]/source/route";

const requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const source = {
  objectId: "obj-1",
  versionId: "version-2",
  versionNumber: 2,
  bodyFormat: "markdown",
  body: "# Guide",
  sha256: "hash",
};
interface TestAuth {
  scopes: string[];
}
const auth: TestAuth = { scopes: ["content:read"] };
type Handler = (
  request: NextRequest,
  auth: TestAuth,
  requestId: string,
  params: { id: string; versionId?: string }
) => Promise<ReturnType<typeof fakeResponse>>;
const currentHandler = GET_CURRENT as unknown as Handler;
const versionHandler = GET_VERSION as unknown as Handler;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireScope.mockReturnValue(null);
  mockRequesterFromApiAuth.mockResolvedValue(requester);
  mockResolve.mockResolvedValue({
    id: source.versionId,
    objectId: source.objectId,
    versionNumber: source.versionNumber,
  });
  mockLoadResolved.mockResolvedValue(source);
  mockCreateApiResponse.mockImplementation(() => fakeResponse());
});

describe("Atrium content source routes (#1288)", () => {
  it("returns current source with its head-version ETag and no-store policy", async () => {
    const response = await currentHandler(
      { headers: { get: () => null } } as unknown as NextRequest,
      auth,
      "req-1",
      { id: "obj-1" }
    );
    expect(mockResolve).toHaveBeenCalledWith(requester, "obj-1");
    expect(mockLoadResolved).toHaveBeenCalledTimes(1);
    expect(response.headers.get("etag")).toBe('"version-2"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 304 without a body for a matching current-source validator", async () => {
    const response = await currentHandler(
      {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "if-none-match" ? '"version-2"' : null,
        },
      } as unknown as NextRequest,
      auth,
      "req-2",
      { id: "obj-1" }
    );
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(mockLoadResolved).not.toHaveBeenCalled();
  });

  it("passes a historic version id and uses revalidated private caching", async () => {
    const response = await versionHandler(
      { headers: { get: () => null } } as unknown as NextRequest,
      auth,
      "req-3",
      { id: "obj-1", versionId: "version-1" }
    );
    expect(mockResolve).toHaveBeenCalledWith(
      requester,
      "obj-1",
      "version-1"
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate"
    );
  });

  it("maps permission/storage failures through typed content errors", async () => {
    const denied = new Error("masked");
    mockResolve.mockRejectedValue(denied);
    mockContentErrorToResponse.mockReturnValue(
      fakeResponse(404, JSON.stringify({ error: { code: "CONTENT_NOT_FOUND" } }))
    );
    const response = await currentHandler(
      { headers: { get: () => null } } as unknown as NextRequest,
      auth,
      "req-4",
      { id: "private" }
    );
    expect(mockContentErrorToResponse).toHaveBeenCalledWith(denied, "req-4");
    expect(response.status).toBe(404);
  });
});
