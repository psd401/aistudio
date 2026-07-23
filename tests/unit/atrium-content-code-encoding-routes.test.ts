/**
 * `codeEncoding: "base64"` decode on the REST content-write routes
 * (`POST /api/v1/content` create + `POST /api/v1/content/:id/versions`).
 *
 * These drive the real route handlers (withApiAuth unwrapped to the identity) and
 * assert the transit contract:
 *   - a base64 body is DECODED before `contentService.create` / `.createVersion`
 *     is called — i.e. the service (and its §28.3 guardrails/PII screening, which
 *     reads `input.body`) always sees the real, decoded content, never the wrapper,
 *   - an invalid base64 body is a 400 (ValidationError → contentErrorToResponse)
 *     and the service is NEVER called,
 *   - an omitted `codeEncoding` passes the raw body straight through (back-compat).
 *
 * The decode helper itself (`decodeContentBody`) is NOT mocked here — the point is
 * the route wiring — so its real validation runs.
 */

const mockCreate = jest.fn();
const mockCreateVersion = jest.fn();
const mockParseRequestBody = jest.fn();
const mockResolveRestRequester = jest.fn();
const mockContentErrorToResponse = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockResolveCollectionId = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: jest.fn(() => null),
  createApiResponse: (...a: unknown[]) => mockCreateApiResponse(...a),
  createErrorResponse: jest.fn(() => ({ __marker: "error" })),
  parseRequestBody: (...a: unknown[]) => mockParseRequestBody(...a),
}));

jest.mock("@/lib/content", () => {
  class MockApprovalRequiredError extends Error {}
  return {
    ApprovalRequiredError: MockApprovalRequiredError,
    contentService: {
      create: (...a: unknown[]) => mockCreate(...a),
      createVersion: (...a: unknown[]) => mockCreateVersion(...a),
    },
    versionService: { list: jest.fn() },
    hasPublishPublicScope: jest.fn(() => false),
    recordContentAudit: jest.fn(),
    requesterFromApiAuth: jest.fn(),
  };
});

jest.mock("@/lib/content/rest", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { z } = require("zod") as typeof import("zod");
  return {
    contentErrorToResponse: (...a: unknown[]) => mockContentErrorToResponse(...a),
    resolveRestRequester: (...a: unknown[]) => mockResolveRestRequester(...a),
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
import { POST as CREATE } from "@/app/api/v1/content/route";
import { POST as CREATE_VERSION } from "@/app/api/v1/content/[id]/versions/route";
import { ValidationError } from "@/lib/content/errors";

const REQ = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const AUTH = { scopes: ["content:create", "content:update"], cognitoSub: "sub-7" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

type CreateHandler = (
  request: NextRequest,
  auth: typeof AUTH,
  requestId: string
) => Promise<unknown>;
type VersionHandler = (
  request: NextRequest,
  auth: typeof AUTH,
  requestId: string,
  params: { id: string }
) => Promise<unknown>;

const createHandler = CREATE as unknown as CreateHandler;
const versionHandler = CREATE_VERSION as unknown as VersionHandler;

const request = { url: "https://app.test/api/v1/content" } as unknown as NextRequest;

const ARTIFACT_CODE =
  '<html><style>b{color:red}</style><script>alert("x")</script></html>';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRestRequester.mockResolvedValue({ req: REQ });
  mockResolveCollectionId.mockResolvedValue(undefined);
  mockCreate.mockResolvedValue({ id: "obj-1", slug: "art", visibilityLevel: "private" });
  mockCreateVersion.mockResolvedValue({ id: "obj-1", slug: "art", version: { id: "v2" } });
  mockContentErrorToResponse.mockReturnValue({ __marker: "content-error" });
  mockCreateApiResponse.mockReturnValue({ __marker: "ok" });
});

describe("POST /api/v1/content — codeEncoding decode", () => {
  it("decodes a base64 artifact body before contentService.create (screening sees decoded content)", async () => {
    mockParseRequestBody.mockResolvedValue({
      data: {
        kind: "artifact",
        title: "Chart",
        body: b64(ARTIFACT_CODE),
        bodyFormat: "html",
        codeEncoding: "base64",
      },
    });

    await createHandler(request, AUTH, "req-1");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The service (which runs §28.3 screening on input.body) receives the DECODED
    // artifact code, never the base64 wrapper.
    expect(mockCreate).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({ body: ARTIFACT_CODE }),
      expect.anything()
    );
  });

  it("passes a raw body straight through when codeEncoding is omitted", async () => {
    mockParseRequestBody.mockResolvedValue({
      data: { kind: "document", title: "Doc", body: "# hello", bodyFormat: "markdown" },
    });

    await createHandler(request, AUTH, "req-2");

    expect(mockCreate).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({ body: "# hello" }),
      expect.anything()
    );
  });

  it("passes validated capture provenance to the create service", async () => {
    const sourceRef = {
      type: "capture",
      provider: "atrium-capture",
      externalId: "capture-session-123",
      clientSurface: "browser",
      clientVersion: "1.0.0",
      capturedAt: "2026-07-23T03:15:00.000Z",
      sourceOrigins: ["https://example.edu"],
    };
    mockParseRequestBody.mockResolvedValue({
      data: {
        kind: "document",
        title: "Captured guide",
        body: "# guide",
        sourceRef,
      },
    });

    await createHandler(request, AUTH, "req-source");

    expect(mockCreate).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({ sourceRef }),
      expect.anything()
    );
  });

  it("rejects an invalid base64 body with a 400 and never calls the service", async () => {
    mockParseRequestBody.mockResolvedValue({
      data: {
        kind: "artifact",
        title: "Bad",
        body: "<script>not base64</script>",
        bodyFormat: "html",
        codeEncoding: "base64",
      },
    });

    const result = await createHandler(request, AUTH, "req-3");

    expect(mockCreate).not.toHaveBeenCalled();
    // ValidationError's constructor hardcodes status 400 → contentErrorToResponse
    // maps it to a 400 envelope.
    expect(mockContentErrorToResponse).toHaveBeenCalledWith(
      expect.any(ValidationError),
      expect.anything()
    );
    expect(result).toEqual({ __marker: "content-error" });
  });
});

describe("POST /api/v1/content/:id/versions — codeEncoding decode", () => {
  it("decodes a base64 body before contentService.createVersion", async () => {
    mockParseRequestBody.mockResolvedValue({
      data: { body: b64(ARTIFACT_CODE), bodyFormat: "html", codeEncoding: "base64" },
    });

    await versionHandler(request, AUTH, "req-4", { id: "obj-1" });

    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
    expect(mockCreateVersion).toHaveBeenCalledWith(
      REQ,
      "obj-1",
      expect.objectContaining({ body: ARTIFACT_CODE })
    );
  });

  it("rejects invalid base64 with a 400 and never calls the service", async () => {
    mockParseRequestBody.mockResolvedValue({
      data: { body: "!!!not-base64!!!", bodyFormat: "html", codeEncoding: "base64" },
    });

    await versionHandler(request, AUTH, "req-5", { id: "obj-1" });

    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockContentErrorToResponse).toHaveBeenCalledWith(
      expect.any(ValidationError),
      expect.anything()
    );
  });
});
