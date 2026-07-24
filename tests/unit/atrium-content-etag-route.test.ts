const mockGet = jest.fn();
const mockCreateApiResponse = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: jest.fn(() => null),
  createApiResponse: (...args: unknown[]) => mockCreateApiResponse(...args),
  createErrorResponse: jest.fn(),
  parseRequestBody: jest.fn(),
}));
jest.mock("@/lib/content", () => ({
  contentService: {
    get: (...args: unknown[]) => mockGet(...args),
    update: jest.fn(),
    delete: jest.fn(),
  },
  contentHeadEtag: (id: string | null) => `"${id ?? "none"}"`,
  recordContentAudit: jest.fn(),
  requesterFromApiAuth: jest.fn(async () => ({ kind: "user", userId: 7 })),
}));
jest.mock("@/lib/content/rest", () => ({
  contentErrorToResponse: jest.fn(),
  resolveRestRequester: jest.fn(),
}));
jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: jest.fn(),
  contentDeepLink: (slug: string) => `/c/${slug}`,
  resolveCollectionId: jest.fn(),
}));

import type { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/content/[id]/route";

interface Auth {
  scopes: string[];
}

type Handler = (
  request: NextRequest,
  auth: Auth,
  requestId: string,
  params: { id: string }
) => Promise<{ headers: Map<string, string> }>;

const handler = GET as unknown as Handler;
const request = {} as NextRequest;
const auth = { scopes: ["content:read"] };

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateApiResponse.mockImplementation(() => ({
    headers: new Map<string, string>(),
  }));
});

describe("GET /api/v1/content/:id ETag", () => {
  it("returns the current version id as a strong ETag", async () => {
    mockGet.mockResolvedValue({
      id: "object-1",
      slug: "guide",
      currentVersionId: "11111111-1111-4111-8111-111111111111",
    });

    const response = await handler(request, auth, "request-1", {
      id: "object-1",
    });

    expect(response.headers.get("ETag")).toBe(
      '"11111111-1111-4111-8111-111111111111"'
    );
  });

  it('returns the explicit "none" sentinel before the first version', async () => {
    mockGet.mockResolvedValue({
      id: "object-1",
      slug: "guide",
      currentVersionId: null,
    });

    const response = await handler(request, auth, "request-2", {
      id: "object-1",
    });

    expect(response.headers.get("ETag")).toBe('"none"');
  });
});
