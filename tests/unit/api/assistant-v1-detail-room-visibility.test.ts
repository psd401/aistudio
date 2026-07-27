/** @jest-environment node */

import { NextRequest, NextResponse } from "next/server";

const mockGetAssistantForAccessCheck = jest.fn();
const mockGetAssistantById = jest.fn();
const mockUserCanAccessResource = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth:
    (
      handler: (
        request: NextRequest,
        auth: { userId: number; cognitoSub: string; scopes: string[] },
        requestId: string
      ) => Promise<NextResponse>
    ) =>
    (request: NextRequest) =>
      handler(
        request,
        {
          userId: 42,
          cognitoSub: "student-sub",
          scopes: ["assistants:list"],
        },
        "request-1"
      ),
  requireScope: jest.fn(() => null),
  createApiResponse: (data: unknown) => NextResponse.json(data),
  createErrorResponse: (
    requestId: string,
    status: number,
    code: string,
    message: string
  ) => NextResponse.json(
    { requestId, error: { code, message } },
    { status }
  ),
  extractNumericParam: jest.fn(() => 7),
  verifyAssistantAccess: jest.fn(() => null),
}));

jest.mock("@/lib/api/assistant-service", () => ({
  getAssistantForAccessCheck: (...args: unknown[]) =>
    mockGetAssistantForAccessCheck(...args),
  getAssistantById: (...args: unknown[]) => mockGetAssistantById(...args),
}));

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  userCanAccessResource: (...args: unknown[]) =>
    mockUserCanAccessResource(...args),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { GET } from "@/app/api/v1/assistants/[id]/route";

describe("v1 assistant detail room visibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAssistantForAccessCheck.mockResolvedValue({
      userId: 9,
      status: "approved",
    });
    mockGetAssistantById.mockResolvedValue({
      id: 7,
      name: "Assigned",
      status: "approved",
    });
  });

  it("masks a room-hidden assistant as 404 before loading details", async () => {
    mockUserCanAccessResource.mockResolvedValue(false);

    const response = await GET(
      new NextRequest("http://localhost/api/v1/assistants/7"),
      { params: Promise.resolve({ id: "7" }) }
    );

    expect(response.status).toBe(404);
    expect(mockGetAssistantById).not.toHaveBeenCalled();
    expect(mockUserCanAccessResource).toHaveBeenCalledWith(
      42,
      "assistant",
      7,
      { ownerUserId: 9 }
    );
  });

  it("returns details when the shared room/resource gate grants access", async () => {
    mockUserCanAccessResource.mockResolvedValue(true);

    const response = await GET(
      new NextRequest("http://localhost/api/v1/assistants/7"),
      { params: Promise.resolve({ id: "7" }) }
    );

    expect(response.status).toBe(200);
    expect(mockGetAssistantById).toHaveBeenCalledWith(7);
  });
});
