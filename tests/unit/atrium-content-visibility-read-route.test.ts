/**
 * GET /api/v1/content/:id/visibility — the grant-list read (#1763).
 *
 * The PATCH counterpart REPLACES an object's grant set, and `GET
 * /api/v1/content/:id` exposes only a `grantCount` integer. Without this read a
 * caller narrowing or widening an object has to re-send a GUESSED grant list,
 * and a wrong guess silently drops access no audit trail can restore. These
 * tests pin what the ROUTE owns: the correct read scope, id validation, the
 * response envelope, and typed-error mapping for the 404 mask. The EDIT gate
 * itself (grants name every principal with access, so a viewer must not
 * enumerate them) lives in `readVisibilityForEdit`, shared with the agent
 * broker, and is pinned in `atrium-visibility-read.test.ts`.
 */

const mockRequireScope = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockCreateErrorResponse = jest.fn();
const mockParseRequestBody = jest.fn();
const mockReadVisibilityForEdit = jest.fn();
const mockContentErrorToResponse = jest.fn();

function fakeResponse(status = 200, body: unknown = null) {
  return { status, body };
}

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
  createApiResponse: (...args: unknown[]) => mockCreateApiResponse(...args),
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
  parseRequestBody: (...args: unknown[]) => mockParseRequestBody(...args),
}));
jest.mock("@/lib/content", () => ({
  ApprovalRequiredError: class ApprovalRequiredError extends Error {},
  contentService: { loadForEdit: jest.fn() },
  hasPublishPublicScope: () => false,
  readVisibilityForEdit: (...args: unknown[]) =>
    mockReadVisibilityForEdit(...args),
  recordContentAudit: jest.fn(),
  visibilityService: { grantsFor: jest.fn(), setLevel: jest.fn() },
}));
jest.mock("@/lib/content/rest", () => ({
  contentErrorToResponse: (...args: unknown[]) =>
    mockContentErrorToResponse(...args),
  resolveRestRequester: async () => ({ req: { kind: "user", userId: 7 } }),
  respondApprovalRequired: jest.fn(),
  restVisibilitySchema: {},
}));
jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import type { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/content/[id]/visibility/route";

interface TestAuth {
  scopes: string[];
}
type Handler = (
  request: NextRequest,
  auth: TestAuth,
  requestId: string,
  params: { id?: string }
) => Promise<ReturnType<typeof fakeResponse>>;
const handler = GET as unknown as Handler;
const request = { headers: { get: () => null } } as unknown as NextRequest;
const auth: TestAuth = { scopes: ["content:read"] };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireScope.mockReturnValue(null);
  mockReadVisibilityForEdit.mockResolvedValue({
    id: "obj-1",
    visibility: {
      visibilityLevel: "group",
      grants: [
        { kind: "role", value: "staff" },
        { kind: "user", value: "41" },
      ],
    },
  });
  mockCreateApiResponse.mockImplementation(() => fakeResponse());
  mockCreateErrorResponse.mockImplementation((_id, status) =>
    fakeResponse(status)
  );
});

describe("GET /api/v1/content/:id/visibility (#1763)", () => {
  it("returns the level and the ACTUAL grant entries to an editor", async () => {
    await handler(request, auth, "req-1", { id: "obj-1" });
    expect(mockRequireScope).toHaveBeenCalledWith(
      auth,
      "content:read",
      "req-1"
    );
    expect(mockReadVisibilityForEdit).toHaveBeenCalledWith(
      { kind: "user", userId: 7 },
      "obj-1"
    );
    expect(mockCreateApiResponse).toHaveBeenCalledWith(
      {
        data: {
          id: "obj-1",
          visibility: {
            visibilityLevel: "group",
            grants: [
              { kind: "role", value: "staff" },
              { kind: "user", value: "41" },
            ],
          },
        },
        meta: { requestId: "req-1" },
      },
      "req-1"
    );
  });

  it("refuses without the read scope and touches no service", async () => {
    mockRequireScope.mockReturnValue(fakeResponse(403));
    const response = await handler(request, auth, "req-2", { id: "obj-1" });
    expect(response.status).toBe(403);
    expect(mockReadVisibilityForEdit).not.toHaveBeenCalled();
  });

  it("rejects a missing id before resolving the requester", async () => {
    const response = await handler(request, auth, "req-3", {});
    expect(response.status).toBe(400);
    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-3",
      400,
      "VALIDATION_ERROR",
      "Missing content id"
    );
    expect(mockReadVisibilityForEdit).not.toHaveBeenCalled();
  });

  it("maps the edit-gate failure through the typed content error (404 mask)", async () => {
    const denied = new Error("masked");
    mockReadVisibilityForEdit.mockRejectedValue(denied);
    mockContentErrorToResponse.mockReturnValue(fakeResponse(404));
    const response = await handler(request, auth, "req-4", { id: "obj-1" });
    expect(response.status).toBe(404);
    expect(mockContentErrorToResponse).toHaveBeenCalledWith(denied, "req-4");
    expect(mockCreateApiResponse).not.toHaveBeenCalled();
  });
});
